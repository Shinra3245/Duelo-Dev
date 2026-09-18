import {
  ERROR_CODES,
  ERROR_MESSAGES,
  resolveWinnerId,
  type AdminPlayerSummary,
  type AdminRankingEntry,
  type AdminRoomSummary,
  type MatchEntity,
  type MatchStatus,
  type UserEntity,
} from '@duelodev/shared';
import { HttpError } from '../plugins/body-parser.js';
import type { RoomRepository, UserRepository } from '../repositories/types.js';
import type { AuditService } from './audit.js';
import { hashPassword } from './password.js';

/** Correo único autorizado para el panel administrativo. */
export const ADMIN_ALLOWED_EMAIL = 'omarbolanos@gmail.com';
const ADMIN_GAMERTAG = 'admin-duelodev';
const ACTIVE_MATCH_STATUSES: MatchStatus[] = ['lobby', 'running', 'settling'];

export interface AdminServiceOptions {
  roomRepo: RoomRepository;
  userRepo: UserRepository;
  auditService?: AuditService;
}

export interface AdminListOptions {
  limit?: number;
  offset?: number;
  status?: MatchStatus;
  query?: string;
}

function boundedPageValue(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.max(0, Math.min(max, value));
}

function toAdminPlayer(
  player: {
    user_id: string;
    score: number;
    cases_total: number;
    time_total_ms: number;
    connection_status: string;
    is_ready: boolean;
    is_revealed: boolean;
  },
  user: UserEntity | null,
): AdminPlayerSummary {
  return {
    user_id: player.user_id,
    gamertag: user?.gamertag ?? player.user_id,
    email: user?.email ?? null,
    score: player.score,
    cases_total: player.cases_total,
    time_total_ms: player.time_total_ms,
    connection_status: player.connection_status,
    is_ready: player.is_ready,
    is_revealed: player.is_revealed,
  };
}

export class AdminService {
  private readonly roomRepo: RoomRepository;
  private readonly userRepo: UserRepository;
  private readonly auditService: AuditService | undefined;

  constructor(options: AdminServiceOptions) {
    this.roomRepo = options.roomRepo;
    this.userRepo = options.userRepo;
    this.auditService = options.auditService;
  }

  async listRooms(options: AdminListOptions = {}): Promise<AdminRoomSummary[]> {
    const limit = boundedPageValue(options.limit, 50, 100);
    const offset = boundedPageValue(options.offset, 0, 100_000);
    const matches =
      options.status === undefined
        ? await this.requireRoomListing({ limit, offset })
        : await this.requireRoomListing({ limit, offset, status: options.status });
    return Promise.all(matches.map((match) => this.toRoomSummary(match)));
  }

  async listPlayers(
    options: AdminListOptions = {},
  ): Promise<Array<AdminPlayerSummary & { match_id: string; room_code: string }>> {
    const limit = boundedPageValue(options.limit, 100, 500);
    const offset = boundedPageValue(options.offset, 0, 100_000);
    const matches = await this.loadHistoricalMatches();
    const query = options.query?.trim().toLowerCase();
    const rows: Array<AdminPlayerSummary & { match_id: string; room_code: string }> = [];

    for (const match of matches) {
      const players = await this.roomRepo.findPlayersByMatchId(match.id);
      for (const player of players) {
        const user = await this.userRepo.findById(player.user_id);
        const summary = toAdminPlayer(player, user);
        if (
          query &&
          !summary.gamertag.toLowerCase().includes(query) &&
          !(summary.email?.toLowerCase().includes(query) ?? false)
        ) {
          continue;
        }
        rows.push({ ...summary, match_id: match.id, room_code: match.room_code });
      }
    }

    return rows
      .sort(
        (a, b) => a.gamertag.localeCompare(b.gamertag) || a.room_code.localeCompare(b.room_code),
      )
      .slice(offset, offset + limit);
  }

  async ranking(): Promise<AdminRankingEntry[]> {
    const matches = await this.loadHistoricalMatches();
    const aggregate = new Map<string, Omit<AdminRankingEntry, 'rank' | 'gamertag'>>();

    for (const match of matches) {
      const winners = new Set(match.winner_ids);
      const players = await this.roomRepo.findPlayersByMatchId(match.id);
      for (const player of players) {
        const current = aggregate.get(player.user_id) ?? {
          user_id: player.user_id,
          matches_played: 0,
          wins: 0,
          score: 0,
          cases_total: 0,
          time_total_ms: 0,
        };
        current.matches_played += 1;
        current.wins += winners.has(player.user_id) ? 1 : 0;
        current.score += player.score;
        current.cases_total += player.cases_total;
        current.time_total_ms += player.time_total_ms;
        aggregate.set(player.user_id, current);
      }
    }

    const entries = await Promise.all(
      [...aggregate.values()].map(async (entry) => ({
        ...entry,
        gamertag: (await this.userRepo.findById(entry.user_id))?.gamertag ?? entry.user_id,
      })),
    );

    entries.sort(
      (a, b) =>
        b.score - a.score ||
        b.cases_total - a.cases_total ||
        b.wins - a.wins ||
        a.time_total_ms - b.time_total_ms ||
        a.gamertag.localeCompare(b.gamertag),
    );

    return entries.map((entry, index) => ({
      ...entry,
      rank:
        index > 0 &&
        entry.score === entries[index - 1]!.score &&
        entry.cases_total === entries[index - 1]!.cases_total &&
        entry.time_total_ms === entries[index - 1]!.time_total_ms
          ? index
          : index + 1,
    }));
  }

  async overrideResult(
    matchId: string,
    winnerIds: string[],
    adminUserId: string,
  ): Promise<AdminRoomSummary> {
    const match = await this.roomRepo.findMatchById(matchId);
    if (!match) {
      throw new HttpError(404, ERROR_CODES.ROOM_NOT_FOUND, ERROR_MESSAGES.ROOM_NOT_FOUND);
    }

    const uniqueWinnerIds = [...new Set(winnerIds)];
    if (uniqueWinnerIds.length > 3) {
      throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, ERROR_MESSAGES.VALIDATION_FAILED);
    }

    const players = await this.roomRepo.findPlayersByMatchId(match.id);
    const playerIds = new Set(players.map((player) => player.user_id));
    if (uniqueWinnerIds.some((winnerId) => !playerIds.has(winnerId))) {
      throw new HttpError(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        'El ganador debe pertenecer a la sala.',
      );
    }

    const updated = await this.roomRepo.updateMatch(match.id, {
      status: 'finished',
      winner_ids: uniqueWinnerIds,
      winner_id: resolveWinnerId(uniqueWinnerIds),
      finish_reason: 'admin_override',
      finished_at: new Date().toISOString(),
      state_version: match.state_version + 1,
    });
    if (!updated) {
      throw new HttpError(500, ERROR_CODES.INTERNAL, ERROR_MESSAGES.INTERNAL);
    }

    await this.auditService?.record('match', match.id, 'admin_result_overridden', {
      admin_user_id: adminUserId,
      winner_ids: uniqueWinnerIds,
      previous_status: match.status,
    });

    return this.toRoomSummary(updated);
  }

  async closeRoom(
    matchId: string,
    adminUserId: string,
  ): Promise<{ room: AdminRoomSummary; closed: boolean; audited: boolean }> {
    const match = await this.roomRepo.findMatchById(matchId);
    if (!match) {
      throw new HttpError(404, ERROR_CODES.ROOM_NOT_FOUND, ERROR_MESSAGES.ROOM_NOT_FOUND);
    }

    if (!ACTIVE_MATCH_STATUSES.includes(match.status)) {
      return { room: await this.toRoomSummary(match), closed: false, audited: false };
    }

    const updated = await this.roomRepo.updateMatch(match.id, {
      status: 'abandoned',
      winner_ids: [],
      winner_id: null,
      finish_reason: 'admin_override',
      finished_at: new Date().toISOString(),
      state_version: match.state_version + 1,
    });
    if (!updated) {
      throw new HttpError(500, ERROR_CODES.INTERNAL, ERROR_MESSAGES.INTERNAL);
    }

    await this.auditService?.record('match', match.id, 'admin_room_closed', {
      admin_user_id: adminUserId,
      previous_status: match.status,
      room_code: match.room_code,
    });

    return { room: await this.toRoomSummary(updated), closed: true, audited: true };
  }

  async closeAllRooms(
    adminUserId: string,
  ): Promise<{ rooms: AdminRoomSummary[]; closed_count: number; audited: boolean }> {
    const activeMatches: MatchEntity[] = [];
    for (const status of ACTIVE_MATCH_STATUSES) {
      let offset = 0;
      for (;;) {
        const page = await this.requireRoomListing({ limit: 100, offset, status });
        activeMatches.push(...page);
        if (page.length < 100) break;
        offset += page.length;
      }
    }

    const closed = await Promise.all(
      activeMatches.map((match) => this.closeRoom(match.id, adminUserId)),
    );

    return {
      rooms: closed.map((result) => result.room),
      closed_count: closed.filter((result) => result.closed).length,
      audited: closed.every((result) => result.audited),
    };
  }

  private async requireRoomListing(options: {
    limit: number;
    offset: number;
    status?: MatchStatus;
  }) {
    if (!this.roomRepo.findAllMatches) {
      throw new HttpError(500, ERROR_CODES.INTERNAL, ERROR_MESSAGES.INTERNAL);
    }
    return this.roomRepo.findAllMatches(options);
  }

  private async loadHistoricalMatches() {
    const pageSize = 500;
    const matches = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.requireRoomListing({ limit: pageSize, offset });
      matches.push(...page);
      if (page.length < pageSize) return matches;
    }
  }

  private async toRoomSummary(match: MatchEntity): Promise<AdminRoomSummary> {
    const players = await this.roomRepo.findPlayersByMatchId(match.id);
    return {
      match_id: match.id,
      room_code: match.room_code,
      mode: match.mode,
      status: match.status,
      config: match.config,
      host_id: match.host_id,
      winner_ids: match.winner_ids,
      winner_id: match.winner_id,
      finish_reason: match.finish_reason,
      started_at: match.started_at,
      ends_at: match.ends_at,
      finished_at: match.finished_at,
      created_at: match.created_at,
      players: await Promise.all(
        players.map(async (player) =>
          toAdminPlayer(player, await this.userRepo.findById(player.user_id)),
        ),
      ),
    };
  }
}

/**
 * Crea o eleva únicamente la cuenta administrativa configurada en el código.
 * La contraseña sólo llega desde el entorno y nunca se devuelve ni se audita.
 */
export async function ensureConfiguredAdmin(
  userRepo: UserRepository,
  rawPassword: string,
): Promise<UserEntity> {
  if (rawPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD debe tener al menos 12 caracteres');
  }

  const passwordHash = await hashPassword(rawPassword);
  const existing = await userRepo.findByEmail(ADMIN_ALLOWED_EMAIL);
  if (existing) {
    const updated = await userRepo.update(existing.id, {
      password_hash: passwordHash,
      role: 'admin',
    });
    if (!updated) throw new Error('No se pudo actualizar la cuenta administrativa');
    return updated;
  }

  let gamertag = ADMIN_GAMERTAG;
  if (await userRepo.findByGamertag(gamertag)) {
    gamertag = `${ADMIN_GAMERTAG}-1`;
  }
  return userRepo.create({
    email: ADMIN_ALLOWED_EMAIL,
    password_hash: passwordHash,
    gamertag,
    role: 'admin',
  });
}
