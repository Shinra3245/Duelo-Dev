import { randomBytes } from 'node:crypto';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  comparePlayerScores,
  determineWinners,
  type CreateRoomRequest,
  type JoinRoomRequest,
  type JoinRoomResponse,
  type MatchCodeSnapshot,
  type MatchFinishReason,
  type MatchSummaryResponse,
  type PlayerScore,
  type RoomCreatedResponse,
  type RoomDetailsResponse,
  type RoomPlayerSummary,
  type StartRoomResponse,
} from '@duelodev/shared';

import { HttpError } from '../plugins/body-parser.js';
import type {
  RoomCreationPolicyRepository,
  RoomRepository,
  UserRepository,
} from '../repositories/types.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import type { MatchControlPublisher } from '../queue/control.js';

const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Genera un código legible de sala alfanumérico en mayúsculas (doc 04 §2).
 */
export function generateRoomCode(length = 6): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

export interface RoomServiceOptions {
  roomRepo: RoomRepository;
  roomCreationPolicyRepo?: RoomCreationPolicyRepository;
  userRepo: UserRepository;
  authService: AuthService;
  instructionsDurationMs?: number;
  matchControlPublisher?: MatchControlPublisher | undefined;
  auditService?: AuditService | undefined;
}

/**
 * Servicio de salas y ciclo de vida de partidas en lobby (doc 04 §2).
 */
export class RoomService {
  private readonly roomRepo: RoomRepository;
  private readonly roomCreationPolicyRepo: RoomCreationPolicyRepository | undefined;
  private readonly userRepo: UserRepository;
  private readonly authService: AuthService;
  private readonly instructionsDurationMs: number;
  private readonly matchControlPublisher: MatchControlPublisher | undefined;
  private readonly auditService?: AuditService | undefined;

  constructor(options: RoomServiceOptions) {
    this.roomRepo = options.roomRepo;
    this.roomCreationPolicyRepo = options.roomCreationPolicyRepo;
    this.userRepo = options.userRepo;
    this.authService = options.authService;
    this.instructionsDurationMs = options.instructionsDurationMs ?? 0;
    this.matchControlPublisher = options.matchControlPublisher;
    this.auditService = options.auditService;
  }

  /**
   * Crea una nueva sala de juego. Requiere una sesión válida de usuario o invitado.
   */
  async createRoom(
    userId: string,
    req: CreateRoomRequest,
    baseUrl = 'http://localhost:3000',
  ): Promise<RoomCreatedResponse> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
    }

    if (user.role === 'guest') {
      throw new HttpError(
        403,
        ERROR_CODES.GUEST_ROOM_CREATION_FORBIDDEN,
        ERROR_MESSAGES.GUEST_ROOM_CREATION_FORBIDDEN,
      );
    }
    if (
      user.role !== 'admin' &&
      this.roomCreationPolicyRepo &&
      !(await this.roomCreationPolicyRepo.getRegisteredUsersCanCreateRooms())
    ) {
      throw new HttpError(
        403,
        ERROR_CODES.ROOM_CREATION_DISABLED,
        ERROR_MESSAGES.ROOM_CREATION_DISABLED,
      );
    }

    // Generar código de sala único
    let roomCode = '';
    for (let attempts = 0; attempts < 10; attempts++) {
      const candidate = generateRoomCode(6);
      const existing = await this.roomRepo.findMatchByRoomCode(candidate);
      if (!existing) {
        roomCode = candidate;
        break;
      }
    }

    if (!roomCode) {
      throw new HttpError(500, ERROR_CODES.INTERNAL, ERROR_MESSAGES.INTERNAL);
    }

    const match = await this.roomRepo.createMatch({
      room_code: roomCode,
      mode: req.config.mode,
      status: 'lobby',
      config: req.config,
      host_id: user.id,
      state_version: 1,
      admission_seq: 0,
      winner_ids: [],
    });

    // Añadir al host como primer jugador en la sala
    await this.roomRepo.addPlayer({
      match_id: match.id,
      user_id: user.id,
      is_ready: true,
      connection_status: 'connected',
    });

    if (this.auditService) {
      await this.auditService.recordRoomCreated(match.id, user.id, match.room_code, match.mode);
    }

    const shareUrl = `${baseUrl.replace(/\/+$/, '')}/room/${match.room_code}`;

    return {
      match_id: match.id,
      room_code: match.room_code,
      share_url: shareUrl,
      config: match.config,
      created_at: match.created_at,
    };
  }

  /**
   * Une a un jugador o invitado a la sala (doc 04 §2).
   * Si no está autenticado, crea un nuevo usuario 'guest' y devuelve sus tokens para Set-Cookie.
   */
  async joinRoom(
    rawRoomCode: string,
    req: JoinRoomRequest,
    authenticatedUserId?: string,
  ): Promise<{
    response: JoinRoomResponse;
    newGuestTokens?: { accessToken: string; refreshToken: string };
  }> {
    const roomCode = rawRoomCode.trim().toUpperCase();
    const match = await this.roomRepo.findMatchByRoomCode(roomCode);

    if (!match || match.status === 'finished' || match.status === 'abandoned') {
      throw new HttpError(404, ERROR_CODES.ROOM_NOT_FOUND, ERROR_MESSAGES.ROOM_NOT_FOUND);
    }

    if (match.status !== 'lobby') {
      throw new HttpError(
        409,
        ERROR_CODES.ROOM_ALREADY_STARTED,
        ERROR_MESSAGES.ROOM_ALREADY_STARTED,
      );
    }

    const players = await this.roomRepo.findPlayersByMatchId(match.id);

    // Si el usuario ya está autenticado y ya forma parte de la sala (unión idempotente)
    if (authenticatedUserId) {
      const existingPlayer = players.find((p) => p.user_id === authenticatedUserId);
      if (existingPlayer) {
        const user = await this.userRepo.findById(authenticatedUserId);
        return {
          response: {
            match_id: match.id,
            user_id: authenticatedUserId,
            gamertag: user ? user.gamertag : req.gamertag,
            role: match.host_id === authenticatedUserId ? 'host' : 'player',
            room_code: match.room_code,
          },
        };
      }
    }

    // Verificar capacidad máxima
    if (players.length >= match.config.max_players) {
      throw new HttpError(409, ERROR_CODES.ROOM_FULL, ERROR_MESSAGES.ROOM_FULL);
    }

    // Verificar unicidad de gamertag en la sala (comparación case-insensitive, doc 04 §2)
    const normalizedGamertag = req.gamertag.trim().toLowerCase();
    for (const p of players) {
      const u = await this.userRepo.findById(p.user_id);
      if (u && u.gamertag.toLowerCase() === normalizedGamertag) {
        if (u.id !== authenticatedUserId) {
          throw new HttpError(409, ERROR_CODES.GAMERTAG_TAKEN, ERROR_MESSAGES.GAMERTAG_TAKEN);
        }
      }
    }

    let finalUserId: string;
    let finalGamertag: string;
    let isGuest = !authenticatedUserId;
    let newGuestTokens: { accessToken: string; refreshToken: string } | undefined;

    if (authenticatedUserId) {
      const user = await this.userRepo.findById(authenticatedUserId);
      if (!user) {
        throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
      }
      finalUserId = user.id;
      finalGamertag = user.gamertag;
      isGuest = user.role === 'guest';
    } else {
      // Crear cuenta provisional de invitado (doc 04 §2)
      const guest = await this.authService.createGuest(req.gamertag);
      finalUserId = guest.user.id;
      finalGamertag = guest.user.gamertag;
      isGuest = true;
      newGuestTokens = {
        accessToken: guest.accessToken,
        refreshToken: guest.refreshToken,
      };
    }

    await this.roomRepo.addPlayer({
      match_id: match.id,
      user_id: finalUserId,
      is_ready: true,
      connection_status: 'connected',
    });

    if (this.auditService && isGuest) {
      await this.auditService.recordGuestJoined(match.id, finalUserId, finalGamertag);
    }

    const role = match.host_id === finalUserId ? 'host' : 'player';

    return {
      response: {
        match_id: match.id,
        user_id: finalUserId,
        gamertag: finalGamertag,
        role,
        room_code: match.room_code,
      },
      ...(newGuestTokens ? { newGuestTokens } : {}),
    };
  }

  /**
   * Obtiene los detalles y miembros de la sala para un jugador miembro (doc 04 §2).
   */
  async getRoomDetails(
    rawRoomCode: string,
    requestingUserId?: string,
  ): Promise<RoomDetailsResponse> {
    const roomCode = rawRoomCode.trim().toUpperCase();
    const match = await this.roomRepo.findMatchByRoomCode(roomCode);

    if (!match) {
      throw new HttpError(404, ERROR_CODES.ROOM_NOT_FOUND, ERROR_MESSAGES.ROOM_NOT_FOUND);
    }

    if (!requestingUserId) {
      throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
    }

    const players = await this.roomRepo.findPlayersByMatchId(match.id);
    const isMember =
      players.some((p) => p.user_id === requestingUserId) || match.host_id === requestingUserId;

    if (!isMember) {
      throw new HttpError(403, ERROR_CODES.FORBIDDEN, ERROR_MESSAGES.FORBIDDEN);
    }

    const playerSummaries: RoomPlayerSummary[] = [];
    for (const p of players) {
      const u = await this.userRepo.findById(p.user_id);
      playerSummaries.push({
        user_id: p.user_id,
        gamertag: u ? u.gamertag : 'Desconocido',
        is_ready: p.is_ready,
        is_host: p.user_id === match.host_id,
      });
    }

    return {
      match_id: match.id,
      room_code: match.room_code,
      status: match.status,
      config: match.config,
      host_id: match.host_id,
      players: playerSummaries,
      created_at: match.created_at,
    };
  }

  /**
   * Inicia la partida a petición del anfitrión de manera idempotente (doc 04 §2).
   */
  async startRoom(rawRoomCode: string, requestingUserId: string): Promise<StartRoomResponse> {
    const roomCode = rawRoomCode.trim().toUpperCase();
    const match = await this.roomRepo.findMatchByRoomCode(roomCode);

    if (!match || match.status === 'finished' || match.status === 'abandoned') {
      throw new HttpError(404, ERROR_CODES.ROOM_NOT_FOUND, ERROR_MESSAGES.ROOM_NOT_FOUND);
    }

    if (match.host_id !== requestingUserId) {
      throw new HttpError(403, ERROR_CODES.FORBIDDEN, ERROR_MESSAGES.FORBIDDEN);
    }

    // Idempotencia: si ya está iniciada, responder 200 con started: true
    if (match.status === 'running') {
      await this.publishMatchStarted(match.id, match.state_version);
      return {
        match_id: match.id,
        started: true,
        status: 'running',
      };
    }

    if (match.status === 'settling') {
      throw new HttpError(409, ERROR_CODES.CONFLICT, 'La partida está finalizando.');
    }

    const players = await this.roomRepo.findPlayersByMatchId(match.id);
    if (players.length < 2) {
      throw new HttpError(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        'Se necesitan al menos 2 jugadores para iniciar la partida.',
      );
    }

    const startedAt = Date.now();
    await this.roomRepo.updateMatch(match.id, {
      status: 'running',
      started_at: new Date(startedAt).toISOString(),
      instructions_ends_at:
        this.instructionsDurationMs > 0
          ? new Date(startedAt + this.instructionsDurationMs).toISOString()
          : null,
      state_version: match.state_version + 1,
    });

    if (this.auditService) {
      await this.auditService.recordMatchStarted(match.id, match.host_id, players.length);
    }

    await this.publishMatchStarted(match.id, match.state_version + 1);

    return {
      match_id: match.id,
      started: true,
      status: 'running',
    };
  }

  private async publishMatchStarted(matchId: string, stateVersion: number): Promise<void> {
    await this.matchControlPublisher?.publish({
      schema_version: 1,
      type: 'match_started',
      match_id: matchId,
      state_version: stateVersion,
      issued_at_ms: Date.now(),
    });
  }

  /**
   * Obtiene el resumen de una partida finalizada y sus snapshots de código revelados (doc 04 §2).
   */
  async getMatchSummary(matchId: string, requestingUserId: string): Promise<MatchSummaryResponse> {
    const match = await this.roomRepo.findMatchById(matchId);
    if (!match) {
      throw new HttpError(404, ERROR_CODES.ROOM_NOT_FOUND, ERROR_MESSAGES.ROOM_NOT_FOUND);
    }

    // El solicitante debe ser miembro de la partida
    const player = await this.roomRepo.findPlayer(match.id, requestingUserId);
    if (!player) {
      throw new HttpError(403, ERROR_CODES.NOT_A_PLAYER, ERROR_MESSAGES.NOT_A_PLAYER);
    }

    // Solo permitido en estados terminales
    if (match.status !== 'finished' && match.status !== 'abandoned') {
      throw new HttpError(409, ERROR_CODES.CONFLICT, 'La partida aún no ha finalizado.');
    }

    const allPlayers = await this.roomRepo.findPlayersByMatchId(match.id);
    const userMap = new Map<string, string>();
    for (const p of allPlayers) {
      const user = await this.userRepo.findById(p.user_id);
      if (user) {
        userMap.set(p.user_id, user.gamertag);
      }
    }

    const scores: PlayerScore[] = allPlayers
      .map((p) => ({
        user_id: p.user_id,
        gamertag: userMap.get(p.user_id) ?? p.user_id,
        score: p.score,
        cases_total: p.cases_total,
        time_total_ms: p.time_total_ms,
        current_problem_idx: p.current_problem_idx,
      }))
      .sort(comparePlayerScores);

    const winnerIds =
      match.winner_ids && match.winner_ids.length > 0 ? match.winner_ids : determineWinners(scores);

    const finishReason: MatchFinishReason = match.finish_reason ?? 'abandonment';

    // Obtener snapshots durables registrados para la partida
    const allSnapshots = await this.roomRepo.findSnapshotsByMatch(match.id);

    // Conjunto de jugadores que autorizan revelar su código
    const revealedUserIds = new Set(allPlayers.filter((p) => p.is_revealed).map((p) => p.user_id));

    // Filtrar: un jugador ve sus propios snapshots y los de rivales que tengan is_revealed: true
    const visibleSnapshots: MatchCodeSnapshot[] = allSnapshots
      .filter((s) => s.user_id === requestingUserId || revealedUserIds.has(s.user_id))
      .map((s) => ({
        user_id: s.user_id,
        round_id: s.round_id,
        problem_id: s.problem_id,
        language: s.language,
        source_code: s.source_code,
        captured_at: s.captured_at,
      }));

    return {
      match_id: match.id,
      mode: match.mode,
      status: match.status,
      finish_reason: finishReason,
      winner_ids: winnerIds,
      final_scores: scores,
      started_at: match.started_at ?? match.created_at,
      finished_at: match.finished_at ?? new Date().toISOString(),
      snapshots: visibleSnapshots,
    };
  }
}
