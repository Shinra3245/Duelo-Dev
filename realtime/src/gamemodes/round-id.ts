import { createHash } from 'node:crypto';

/**
 * Identificador estable de una ronda individual.
 *
 * Las tablas de submissions y snapshots usan UUID para `round_id`, por lo que
 * no se pueden enviar etiquetas legibles como `round-u-{user}-{index}` al API.
 * El hash mantiene el mismo identificador después de una reconexión o de
 * reconstruir la sesión desde PostgreSQL.
 */
function stableRoundId(identity: string): string {
  const digest = createHash('sha256').update(identity).digest('hex');
  const uuidHex = digest.split('');

  // Mantener formato UUID v5 para que el valor sea válido también para
  // herramientas que validan versión y variante, además del tipo PostgreSQL.
  uuidHex[12] = '5';
  uuidHex[16] = ((Number.parseInt(uuidHex[16]!, 16) & 0x3) | 0x8).toString(16);
  const normalized = uuidHex.join('');

  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20, 32)}`;
}

/** Identificador UUID estable de una ronda compartida del modo Puntos. */
export function sharedRoundId(matchId: string, problemIndex: number): string {
  return stableRoundId(`duelodev:round:${matchId}:shared:${problemIndex}`);
}

/** Identificador UUID estable de la ronda individual de un jugador en Rondas. */
export function playerRoundId(matchId: string, userId: string, problemIndex: number): string {
  return stableRoundId(`duelodev:round:${matchId}:${userId}:${problemIndex}`);
}
