/**
 * Tipos y contratos para el transporte colaborativo Yjs (doc 04 §79-88).
 *
 * Cada jugador activo en una partida posee su propio documento Yjs,
 * accesible en `/yjs/{match_id}/{user_id}` con control de acceso:
 * - Escritura: únicamente el dueño autenticado.
 * - Lectura: rivales únicamente si `is_revealed: true` o tras finalizar.
 * - Generaciones: cada ronda avanza la generación; updates de generaciones
 *   anteriores son rechazados.
 * - Límite de tamaño: 256 KiB (`MAX_YDOC_BYTES`) contra agotamiento de memoria.
 */

export interface YjsAuthContext {
  userId: string;
  gamertag: string;
  role: string;
}

export interface YjsClientConnection {
  /** Identificador único de conexión del socket/cliente Yjs. */
  readonly id: string;
  /** Usuario autenticado de la conexión. */
  readonly userId: string;
  /** ID de la partida negociada. */
  readonly matchId: string;
  /** ID del usuario dueño del documento que se está observando/editando. */
  readonly targetUserId: string;
  /** Verdadero si la conexión pertenece al dueño del documento (permiso de escritura). */
  readonly isOwner: boolean;
  /** Envia mensaje binario al cliente. */
  send(data: Uint8Array): void;
  /** Cierra la conexión. */
  close(code?: number, reason?: string): void;
}

export interface CodeSnapshot {
  matchId: string;
  userId: string;
  roundId: string;
  generation: number;
  code: string;
  capturedAt: string;
  isRevealed: boolean;
}

export interface YjsAccessDecision {
  allowed: boolean;
  canRead: boolean;
  canWrite: boolean;
  reason?: string;
}

export interface YjsDocumentMetadata {
  matchId: string;
  userId: string;
  generation: number;
  roundId: string;
  isFrozen: boolean;
  totalBytes: number;
  createdAt: number;
  lastUpdatedAt: number;
  lastSnapshotAt: number;
}
