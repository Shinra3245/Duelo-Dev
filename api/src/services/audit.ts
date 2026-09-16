/**
 * Servicio de auditoría y registro de eventos de producto (doc 04 § 1, doc 04 § 135, doc 08 § Métricas de producto).
 *
 * Invariante de seguridad (doc 04 § 135): «no registrar código/casos».
 * Toda carga de eventos es saneada para eliminar `source_code`, `test_cases`, `cases`,
 * `password`, `password_hash`, `token` y `token_hash`.
 */
import type { Logger } from '@duelodev/shared';
import type { EventEntity, EventRepository } from '../repositories/types.js';

export type StructuredLogger = Logger;

/**
 * Claves sensibles restringidas en eventos de auditoría (doc 04 § 135).
 */
export const SENSITIVE_AUDIT_KEYS = new Set([
  'source_code',
  'test_cases',
  'cases',
  'password',
  'password_hash',
  'token',
  'token_hash',
]);

/**
 * Sanea recursivamente el payload eliminando claves sensibles.
 */
export function sanitizeAuditPayload(
  payload: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 5 || !payload || typeof payload !== 'object') {
    return payload;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_AUDIT_KEYS.has(key.toLowerCase())) {
      continue;
    }

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeAuditPayload(value as Record<string, unknown>, depth + 1);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? sanitizeAuditPayload(item as Record<string, unknown>, depth + 1)
          : item,
      );
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Servicio centralizado para registro durable de eventos de auditoría y producto.
 */
export class AuditService {
  private readonly eventRepo: EventRepository;
  private readonly logger?: StructuredLogger | undefined;

  constructor(eventRepo: EventRepository, logger?: StructuredLogger) {
    this.eventRepo = eventRepo;
    this.logger = logger;
  }

  /**
   * Registra un evento saneando el payload conforme a doc 04 § 135.
   */
  async record(
    aggregateType: string,
    aggregateId: string,
    eventName: string,
    payload: Record<string, unknown> = {},
  ): Promise<EventEntity> {
    const sanitizedPayload = sanitizeAuditPayload(payload);
    const event = await this.eventRepo.recordEvent({
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      event_name: eventName,
      payload: sanitizedPayload,
    });

    this.logger?.info('Evento de auditoría registrado', {
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      event_name: eventName,
    });

    return event;
  }

  /**
   * Registra la creación de una sala de partida (doc 08 § Métricas de producto).
   */
  async recordRoomCreated(
    matchId: string,
    hostId: string,
    roomCode: string,
    mode: string,
  ): Promise<EventEntity> {
    return this.record('match', matchId, 'room_created', {
      host_id: hostId,
      room_code: roomCode,
      mode,
    });
  }

  /**
   * Registra la unión de un usuario invitado a una partida (doc 08 § Métricas de producto).
   */
  async recordGuestJoined(matchId: string, userId: string, gamertag: string): Promise<EventEntity> {
    return this.record('match', matchId, 'guest_joined', {
      user_id: userId,
      gamertag,
    });
  }

  /**
   * Registra el inicio de una partida (doc 08 § Métricas de producto).
   */
  async recordMatchStarted(
    matchId: string,
    hostId: string,
    playersCount: number,
  ): Promise<EventEntity> {
    return this.record('match', matchId, 'match_started', {
      host_id: hostId,
      players_count: playersCount,
    });
  }

  /**
   * Registra un intento de envío a juzgar sin registrar código fuente (doc 04 § 135, doc 08).
   */
  async recordSubmission(
    submissionId: string,
    matchId: string,
    roundId: string,
    userId: string,
    problemId: string,
    language: string,
  ): Promise<EventEntity> {
    return this.record('submission', submissionId, 'submission', {
      match_id: matchId,
      round_id: roundId,
      user_id: userId,
      problem_id: problemId,
      language,
    });
  }

  /**
   * Registra la finalización de una partida con sus ganadores (doc 08 § Métricas de producto).
   */
  async recordMatchFinished(
    matchId: string,
    finishReason: string | null,
    winnerIds: string[],
  ): Promise<EventEntity> {
    return this.record('match', matchId, 'match_finished', {
      finish_reason: finishReason,
      winner_ids: winnerIds,
    });
  }

  /**
   * Registra la conversión de un invitado a usuario registrado (doc 08 § Métricas de producto).
   */
  async recordGuestConverted(userId: string, gamertag: string): Promise<EventEntity> {
    return this.record('user', userId, 'guest_converted', {
      gamertag,
    });
  }

  /**
   * Registra el cambio de visibilidad de código de un jugador (doc 08 § Métricas de producto).
   */
  async recordRevealToggled(
    matchId: string,
    userId: string,
    isRevealed: boolean,
  ): Promise<EventEntity> {
    return this.record('match', matchId, 'reveal_toggled', {
      user_id: userId,
      is_revealed: isRevealed,
    });
  }

  /**
   * Registra la purga y anonimización de un invitado inactivo (doc 04 § 5).
   */
  async recordGuestPurged(userId: string, tombstoneGamertag: string): Promise<EventEntity> {
    return this.record('user', userId, 'guest_purged', {
      tombstone_gamertag: tombstoneGamertag,
    });
  }
}
