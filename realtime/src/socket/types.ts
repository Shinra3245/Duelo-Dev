/**
 * Interfaces abstractas de transporte WebSocket (doc 03 §A2).
 *
 * Desacoplan al MatchHub de Socket.io para que la lógica de partida sea
 * testeable sin dependencias de red. El adaptador concreto de Socket.io
 * se implementará en la Unidad 3.
 */

/** Representa una conexión de cliente individual dentro del namespace `/match`. */
export interface SocketClient {
  /** Identificador único de la conexión de socket. */
  readonly id: string;
  /** ID de usuario autenticado extraído del handshake. */
  readonly userId: string;
  /** Gamertag del jugador, obtenido del token en handshake. */
  readonly gamertag: string;
  /** ID de la partida a la que el cliente se ha unido. */
  matchId?: string | undefined;
  /** Conjunto de rooms a las que el cliente pertenece. */
  readonly rooms: Set<string>;
  /** Une al cliente a una room. */
  join(room: string): void;
  /** Retira al cliente de una room. */
  leave(room: string): void;
  /** Emite un evento al cliente. */
  emit(event: string, payload: unknown): void;
  /** Envía un error estructurado al cliente usando S2C.ERROR. */
  sendError(code: string, message: string, details?: unknown): void;
  /** Desconecta al cliente. */
  disconnect(): void;
}

/** Sala de partida que agrupa las conexiones de los participantes. */
export interface MatchRoom {
  /** Nombre canónico de la sala, `match:{id}` vía `matchRoom(matchId)`. */
  readonly name: string;
  /** Clientes activos en la sala, indexados por `SocketClient.id`. */
  readonly clients: Map<string, SocketClient>;
  /** Difunde un evento a todos los clientes en la sala, opcionalmente excluyendo uno. */
  broadcast(event: string, payload: unknown, exceptClientId?: string): void;
}
