import type { ConnectedPlayer, PlayerConnection, RealtimeMatchSession } from '../types.js';

/**
 * Contrato de almacén de partidas en tiempo real (doc 03 § Límites de responsabilidad).
 *
 * Estado serializable y versionado, sin variables globales de partida ni timers persistidos.
 */
export interface MatchStore {
  /**
   * Obtiene una sesión de partida por su identificador único.
   */
  getMatch(matchId: string): Promise<RealtimeMatchSession | null>;

  /**
   * Guarda o actualiza una sesión de partida en el almacén.
   */
  saveMatch(session: RealtimeMatchSession): Promise<void>;

  /**
   * Elimina una sesión de partida del almacén.
   */
  deleteMatch(matchId: string): Promise<void>;

  /**
   * Actualiza el estado de conexión y presencia de un jugador en la partida.
   * Retorna el jugador actualizado o null si la partida o el jugador no existen.
   */
  setPlayerPresence(
    matchId: string,
    userId: string,
    connection: PlayerConnection,
    now?: number,
  ): Promise<ConnectedPlayer | null>;

  /**
   * Cuenta las partidas activas (status !== 'finished' && status !== 'abandoned').
   */
  countActiveMatches(): Promise<number>;
}
