import { randomBytes } from 'node:crypto';
import { createLogger, GAMERTAG_REGEX, type Logger, type UserEntity } from '@duelodev/shared';
import type {
  RefreshTokenRepository,
  RoomRepository,
  UserRepository,
} from '../repositories/types.js';
import type { AuditService } from './audit.js';

/** Opciones de configuración para el servicio de retención (doc 04 §5, doc 06 §B04). */
export interface RetentionServiceOptions {
  /** Días de inactividad antes de purgar un invitado (por defecto: 30, según doc 04 §5). */
  guestRetentionDays?: number;
  /** Prefijo para el gamertag de lápida / tombstone (por defecto: 'anon'). */
  tombstonePrefix?: string;
  /** Servicio opcional de auditoría para registro de eventos de purga. */
  auditService?: AuditService;
}

/** Configuración completa requerida cuando se inicializa por objeto de configuración. */
export interface RetentionServiceConfig extends RetentionServiceOptions {
  userRepo: UserRepository;
  refreshTokenRepo: RefreshTokenRepository;
  roomRepo?: RoomRepository;
  logger?: Logger;
  auditService?: AuditService;
}

/** Resultado consolidado de la ejecución de purga de invitados inactivos. */
export interface RetentionPurgeResult {
  scanned_guests: number;
  purged_guests: number;
  revoked_sessions: number;
  scrubbed_snapshots: number;
  purged_user_ids: string[];
}

/**
 * Genera un gamertag de lápida (tombstone) válido según GAMERTAG_REGEX (^[A-Za-z0-9-]{3,20}$).
 */
export function generateTombstoneGamertag(userId: string, prefix = 'anon'): string {
  const sanitizedPrefix = (prefix.replace(/[^A-Za-z0-9-]/g, '') || 'anon').slice(0, 10);
  const cleanId = userId.replace(/[^A-Za-z0-9]/g, '');
  const suffix = (cleanId.slice(0, 8) || randomBytes(4).toString('hex')).toLowerCase();
  const maxSuffixLen = Math.max(3, 20 - sanitizedPrefix.length - 1);
  const finalSuffix = suffix.slice(0, maxSuffixLen);
  const candidate = `${sanitizedPrefix}-${finalSuffix}`;

  if (GAMERTAG_REGEX.test(candidate)) {
    return candidate;
  }
  return `anon-${randomBytes(4).toString('hex')}`;
}

/**
 * Servicio de Retención y Purga de Invitados (doc 04 §5, doc 06 §B04).
 *
 * Aplica la política de retención para cuentas efímeras (guest):
 * - Identifica usuarios con rol 'guest' sin actividad por más de N días (por defecto 30).
 * - Anonimiza gamertag mediante un tombstone y limpia email y password_hash.
 * - Revoca todas las sesiones activas en refresh_tokens.
 * - Purga snapshots de código no revelados (preservando los que tienen consentimiento de revelado).
 * - Preserva intactas las participaciones históricas (matches, match_players, submissions, match_solves).
 */
export class RetentionService {
  private readonly userRepo: UserRepository;
  private readonly refreshTokenRepo: RefreshTokenRepository;
  private readonly roomRepo?: RoomRepository | undefined;
  private readonly guestRetentionDays: number;
  private readonly tombstonePrefix: string;
  private readonly logger: Logger;
  private readonly auditService?: AuditService | undefined;

  constructor(
    userRepo: UserRepository,
    refreshTokenRepo: RefreshTokenRepository,
    roomRepo?: RoomRepository,
    options?: RetentionServiceOptions,
    logger?: Logger,
    auditService?: AuditService,
  );
  constructor(config: RetentionServiceConfig);
  constructor(
    userRepoOrConfig: UserRepository | RetentionServiceConfig,
    refreshTokenRepo?: RefreshTokenRepository,
    roomRepo?: RoomRepository,
    options?: RetentionServiceOptions,
    logger?: Logger,
    auditService?: AuditService,
  ) {
    if ('userRepo' in userRepoOrConfig) {
      this.userRepo = userRepoOrConfig.userRepo;
      this.refreshTokenRepo = userRepoOrConfig.refreshTokenRepo;
      this.roomRepo = userRepoOrConfig.roomRepo;
      this.guestRetentionDays = userRepoOrConfig.guestRetentionDays ?? 30;
      this.tombstonePrefix = userRepoOrConfig.tombstonePrefix ?? 'anon';
      this.logger = userRepoOrConfig.logger ?? createLogger('retention-service');
      this.auditService = userRepoOrConfig.auditService;
    } else {
      this.userRepo = userRepoOrConfig;
      this.refreshTokenRepo = refreshTokenRepo!;
      this.roomRepo = roomRepo;
      this.guestRetentionDays = options?.guestRetentionDays ?? 30;
      this.tombstonePrefix = options?.tombstonePrefix ?? 'anon';
      this.logger = logger ?? createLogger('retention-service');
      this.auditService = auditService ?? options?.auditService;
    }
  }

  /**
   * Ejecuta la purga periódica de invitados inactivos según la política de retención (doc 04 §5).
   */
  async purgeInactiveGuests(now?: Date): Promise<RetentionPurgeResult> {
    const referenceDate = now ?? new Date();
    const cutoffMs = referenceDate.getTime() - this.guestRetentionDays * 86_400_000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    let inactiveGuests: UserEntity[] = [];
    if (typeof this.userRepo.findInactiveGuests === 'function') {
      inactiveGuests = await this.userRepo.findInactiveGuests(cutoffIso);
    } else {
      this.logger.warn('UserRepository no implementa findInactiveGuests; purga omitida');
    }

    const result: RetentionPurgeResult = {
      scanned_guests: inactiveGuests.length,
      purged_guests: 0,
      revoked_sessions: 0,
      scrubbed_snapshots: 0,
      purged_user_ids: [],
    };

    const nowIso = referenceDate.toISOString();

    for (const guest of inactiveGuests) {
      const {
        user: anonymized,
        revokedSessions,
        scrubbedSnapshots,
      } = await this.processGuestAnonymization(guest, nowIso);

      if (anonymized) {
        result.purged_guests++;
        result.purged_user_ids.push(guest.id);
        result.revoked_sessions += revokedSessions;
        result.scrubbed_snapshots += scrubbedSnapshots;

        if (this.auditService) {
          await this.auditService.recordGuestPurged(guest.id, anonymized.gamertag);
        }
      }
    }

    this.logger.info('Purga de invitados inactivos completada', {
      cutoff_iso: cutoffIso,
      scanned_guests: result.scanned_guests,
      purged_guests: result.purged_guests,
      revoked_sessions: result.revoked_sessions,
      scrubbed_snapshots: result.scrubbed_snapshots,
    });

    return result;
  }

  /**
   * Anonimiza un invitado específico bajo demanda.
   */
  async anonymizeGuest(userId: string, now?: Date): Promise<UserEntity | null> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      return null;
    }

    if (user.role !== 'guest') {
      this.logger.warn('Intento de anonimizar un usuario que no tiene rol guest', {
        userId,
        role: user.role,
      });
      return null;
    }

    const nowIso = (now ?? new Date()).toISOString();
    const {
      user: anonymized,
      revokedSessions,
      scrubbedSnapshots,
    } = await this.processGuestAnonymization(user, nowIso);

    if (anonymized && this.auditService) {
      await this.auditService.recordGuestPurged(userId, anonymized.gamertag);
    }

    this.logger.info('Invitado anonimizado bajo demanda', {
      user_id: userId,
      tombstone_gamertag: anonymized?.gamertag,
      revoked_sessions: revokedSessions,
      scrubbed_snapshots: scrubbedSnapshots,
    });

    return anonymized;
  }

  /**
   * Procesa la anonimización, revocación y limpieza de un invitado individual.
   */
  private async processGuestAnonymization(
    guest: UserEntity,
    nowIso: string,
  ): Promise<{
    user: UserEntity | null;
    revokedSessions: number;
    scrubbedSnapshots: number;
  }> {
    const tombstone = await this.getUniqueTombstoneGamertag(guest.id);

    let anonymized: UserEntity | null = null;
    if (typeof this.userRepo.anonymizeGuest === 'function') {
      anonymized = await this.userRepo.anonymizeGuest(guest.id, tombstone, nowIso);
    } else {
      anonymized = await this.userRepo.update(guest.id, {
        gamertag: tombstone,
        email: null,
        password_hash: null,
        updated_at: nowIso,
      });
    }

    let revokedSessions = 0;
    if (typeof this.refreshTokenRepo.revokeAllForUser === 'function') {
      revokedSessions = await this.refreshTokenRepo.revokeAllForUser(guest.id);
    }

    let scrubbedSnapshots = 0;
    if (this.roomRepo && typeof this.roomRepo.deleteSnapshotsByUser === 'function') {
      scrubbedSnapshots = await this.roomRepo.deleteSnapshotsByUser(guest.id, true);
    }

    return {
      user: anonymized,
      revokedSessions,
      scrubbedSnapshots,
    };
  }

  /**
   * Resuelve un gamertag tombstone garantizando que no colisione con otro usuario existente.
   */
  private async getUniqueTombstoneGamertag(userId: string): Promise<string> {
    const candidate = generateTombstoneGamertag(userId, this.tombstonePrefix);
    const existing = await this.userRepo.findByGamertag(candidate);
    if (!existing || existing.id === userId) {
      return candidate;
    }

    // Colisión detectada: intentar con sufijos aleatorios
    for (let attempt = 0; attempt < 5; attempt++) {
      const altSuffix = randomBytes(3).toString('hex');
      const prefix = (this.tombstonePrefix.replace(/[^A-Za-z0-9-]/g, '') || 'anon').slice(0, 10);
      const altCandidate = `${prefix}-${altSuffix}`;
      const conflict = await this.userRepo.findByGamertag(altCandidate);
      if (!conflict || conflict.id === userId) {
        return altCandidate;
      }
    }

    return `anon-${randomBytes(4).toString('hex')}`;
  }
}
