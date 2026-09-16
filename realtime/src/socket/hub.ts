/**
 * Hub central de partidas en tiempo real (doc 04 §74-108).
 *
 * Coordina la lógica C2S/S2C del namespace `/match`:
 * - `join_match`, `toggle_reveal`, `ready`, `heartbeat` (C2S).
 * - `match_started`, `match_sync`, `verdict`, `score_update`,
 *   `reveal_changed`, `player_status`, `match_finished`, `error` (S2C).
 *
 * El hub es agnóstico de Socket.io: opera sobre las interfaces abstractas
 * `SocketClient` y `MatchRoom` definidas en `./types.ts`.
 *
 * Invariantes clave implementados:
 * - doc 04 §86: `compile_output` solo al dueño del envío; rivales reciben `undefined`.
 * - Reconexión con gracia configurable (`reconnectGraceMs`, defecto RECONNECT_GRACE_MS).
 * - `state_version` monotónico por partida.
 * - Presencia con transición `connected → reconnecting → disconnected`.
 */

import {
  C2S,
  ERROR_CODES,
  matchRoom,
  RECONNECT_GRACE_MS,
  S2C,
  type Logger,
  type MatchFinishedPayload,
  type MatchStartedPayload,
  type MatchSyncPayload,
  type PlayerConnection as SharedPlayerConnection,
  type PlayerScore,
  type VerdictPayload,
} from '@duelodev/shared';
import type { MatchStore } from '../store/types.js';
import type { RealtimeMatchSession } from '../types.js';
import type { SocketClient, MatchRoom } from './types.js';

export interface MatchHubOptions {
  matchStore: MatchStore;
  logger?: Logger | undefined;
  /** Periodo de gracia antes de marcar desconexión definitiva (ms). */
  reconnectGraceMs?: number | undefined;
}

/**
 * Eventos C2S que el hub maneja, mapeados a sus handlers.
 */
export const HUB_C2S_EVENTS = [
  C2S.JOIN_MATCH,
  C2S.TOGGLE_REVEAL,
  C2S.READY,
  C2S.HEARTBEAT,
] as const;

export class MatchHub {
  private readonly matchStore: MatchStore;
  private readonly logger: Logger | undefined;
  private readonly reconnectGraceMs: number;

  /** Clientes conectados indexados por socket.id. */
  private readonly clients = new Map<string, SocketClient>();
  /** Salas de partida indexadas por nombre canónico `match:{id}`. */
  private readonly rooms = new Map<string, MatchRoom>();
  /** Índice userId → Set<socketId> para rastrear reconexiones múltiples. */
  private readonly userSockets = new Map<string, Set<string>>();
  /** Timers de gracia de reconexión por clave `{matchId}:{userId}`. */
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: MatchHubOptions) {
    this.matchStore = options.matchStore;
    this.logger = options.logger;
    this.reconnectGraceMs = options.reconnectGraceMs ?? RECONNECT_GRACE_MS;
  }

  // ─────────────────────── Gestión de clientes ────────────────────────────

  /** Registra un nuevo cliente en el hub. */
  registerClient(client: SocketClient): void {
    this.clients.set(client.id, client);

    let sockets = this.userSockets.get(client.userId);
    if (!sockets) {
      sockets = new Set();
      this.userSockets.set(client.userId, sockets);
    }
    sockets.add(client.id);

    this.logger?.info('Cliente registrado en MatchHub', {
      socket_id: client.id,
      user_id: client.userId,
      gamertag: client.gamertag,
    });
  }

  /** Desregistra un cliente del hub. */
  unregisterClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    this.clients.delete(clientId);

    const sockets = this.userSockets.get(client.userId);
    if (sockets) {
      sockets.delete(clientId);
      if (sockets.size === 0) {
        this.userSockets.delete(client.userId);
      }
    }

    // Remover de rooms
    for (const roomName of client.rooms) {
      const room = this.rooms.get(roomName);
      if (room) {
        room.clients.delete(clientId);
        if (room.clients.size === 0) {
          this.rooms.delete(roomName);
        }
      }
    }
  }

  // ─────────────────────── Gestión de rooms ───────────────────────────────

  /** Obtiene o crea una MatchRoom por su nombre canónico. */
  getOrCreateRoom(name: string): MatchRoom {
    let room = this.rooms.get(name);
    if (!room) {
      room = this.createRoom(name);
      this.rooms.set(name, room);
    }
    return room;
  }

  private createRoom(name: string): MatchRoom {
    const clients = new Map<string, SocketClient>();
    return {
      name,
      clients,
      broadcast(event: string, payload: unknown, exceptClientId?: string): void {
        for (const [id, c] of clients) {
          if (id !== exceptClientId) {
            c.emit(event, payload);
          }
        }
      },
    };
  }

  /** Obtiene una room existente o null. */
  getRoom(name: string): MatchRoom | undefined {
    return this.rooms.get(name);
  }

  // ─────────────────────── Handlers C2S ───────────────────────────────────

  /**
   * C2S.JOIN_MATCH — El jugador solicita unirse a la sala de su partida.
   *
   * Valida existencia de la partida en el MatchStore y que el usuario
   * sea miembro registrado. Si es válido, une al cliente a la room,
   * actualiza presencia y envía sync personalizado.
   */
  async handleJoinMatch(client: SocketClient, payload: { match_id: string }): Promise<void> {
    const matchId = payload.match_id;

    if (typeof matchId !== 'string' || matchId.length === 0) {
      client.sendError(
        ERROR_CODES.VALIDATION_FAILED,
        'match_id es requerido y debe ser una cadena no vacía.',
      );
      return;
    }

    const session = await this.matchStore.getMatch(matchId);
    if (!session) {
      client.sendError(ERROR_CODES.NOT_FOUND, 'Partida no encontrada.');
      return;
    }

    const player = session.players.get(client.userId);
    if (!player) {
      client.sendError('NOT_A_PLAYER', 'No eres miembro de esta partida.', { status: 403 });
      return;
    }

    // Cancelar timer de gracia si existía
    const graceKey = `${matchId}:${client.userId}`;
    this.cancelGraceTimer(graceKey);

    // Unir al cliente a la room
    const roomName = matchRoom(matchId);
    const room = this.getOrCreateRoom(roomName);
    client.join(roomName);
    client.matchId = matchId;
    room.clients.set(client.id, client);

    // Actualizar presencia a connected
    player.connection = 'connected';
    player.socket_id = client.id;
    player.last_seen_at = Date.now();
    session.state_version += 1;
    await this.matchStore.saveMatch(session);

    this.logger?.info('Jugador unido a sala de partida', {
      match_id: matchId,
      user_id: client.userId,
      gamertag: client.gamertag,
      room: roomName,
      state_version: session.state_version,
    });

    // Difundir PLAYER_STATUS a la sala (excepto el propio cliente)
    room.broadcast(
      S2C.PLAYER_STATUS,
      {
        match_id: matchId,
        user_id: client.userId,
        status: 'connected',
        server_time: Date.now(),
      },
      client.id,
    );

    // Enviar MATCH_SYNC personalizado al jugador que se conectó
    const syncPayload = this.buildMatchSyncPayload(session, client.userId);
    client.emit(S2C.MATCH_SYNC, syncPayload);
  }

  /**
   * C2S.TOGGLE_REVEAL — El jugador alterna visibilidad de su código a rivales.
   */
  async handleToggleReveal(client: SocketClient, payload: { visible: boolean }): Promise<void> {
    if (typeof payload.visible !== 'boolean') {
      client.sendError(ERROR_CODES.VALIDATION_FAILED, 'visible es requerido y debe ser booleano.');
      return;
    }

    const matchId = client.matchId;
    if (!matchId) {
      client.sendError(ERROR_CODES.VALIDATION_FAILED, 'No estás en ninguna partida.');
      return;
    }

    const session = await this.matchStore.getMatch(matchId);
    if (!session) {
      client.sendError(ERROR_CODES.NOT_FOUND, 'Partida no encontrada.');
      return;
    }

    const player = session.players.get(client.userId);
    if (!player) {
      client.sendError('NOT_A_PLAYER', 'No eres miembro de esta partida.');
      return;
    }

    player.is_revealed = payload.visible;
    session.state_version += 1;
    await this.matchStore.saveMatch(session);

    const roomName = matchRoom(matchId);
    const room = this.getRoom(roomName);
    if (room) {
      room.broadcast(S2C.REVEAL_CHANGED, {
        match_id: matchId,
        user_id: client.userId,
        visible: payload.visible,
        server_time: Date.now(),
      });
    }

    this.logger?.info('Visibilidad de código actualizada', {
      match_id: matchId,
      user_id: client.userId,
      visible: payload.visible,
      state_version: session.state_version,
    });
  }

  /**
   * C2S.READY — El jugador se marca como listo.
   */
  async handleReady(client: SocketClient): Promise<void> {
    const matchId = client.matchId;
    if (!matchId) {
      client.sendError(ERROR_CODES.VALIDATION_FAILED, 'No estás en ninguna partida.');
      return;
    }

    const session = await this.matchStore.getMatch(matchId);
    if (!session) {
      client.sendError(ERROR_CODES.NOT_FOUND, 'Partida no encontrada.');
      return;
    }

    const player = session.players.get(client.userId);
    if (!player) {
      client.sendError('NOT_A_PLAYER', 'No eres miembro de esta partida.');
      return;
    }

    if (player.is_ready) {
      // Ya está listo, idempotente
      return;
    }

    player.is_ready = true;
    session.state_version += 1;
    await this.matchStore.saveMatch(session);

    const roomName = matchRoom(matchId);
    const room = this.getRoom(roomName);
    if (room) {
      room.broadcast(S2C.PLAYER_STATUS, {
        match_id: matchId,
        user_id: client.userId,
        status: 'connected',
        server_time: Date.now(),
      });
    }

    this.logger?.info('Jugador marcado como listo', {
      match_id: matchId,
      user_id: client.userId,
      state_version: session.state_version,
    });
  }

  /**
   * C2S.HEARTBEAT — Actualiza last_seen_at y responde ack.
   */
  async handleHeartbeat(client: SocketClient): Promise<void> {
    const matchId = client.matchId;
    if (!matchId) {
      // Heartbeat sin partida: solo ack
      client.emit('heartbeat_ack', { server_time: Date.now() });
      return;
    }

    const session = await this.matchStore.getMatch(matchId);
    if (session) {
      const player = session.players.get(client.userId);
      if (player) {
        player.last_seen_at = Date.now();
        await this.matchStore.saveMatch(session);
      }
    }

    client.emit('heartbeat_ack', { server_time: Date.now() });
  }

  /**
   * Manejo de desconexión de un cliente.
   *
   * Transición de presencia:
   * 1. Si el usuario tiene otros sockets activos: no cambia presencia.
   * 2. Si es su último socket: presencia → 'reconnecting', inicia timer de gracia.
   * 3. Si el timer expira sin reconexión: presencia → 'disconnected'.
   */
  async handleDisconnect(client: SocketClient): Promise<void> {
    const matchId = client.matchId;

    this.unregisterClient(client.id);

    if (!matchId) return;

    // Verificar si el usuario tiene otros sockets activos
    const sockets = this.userSockets.get(client.userId);
    if (sockets && sockets.size > 0) {
      // Todavía tiene otras conexiones; no cambiar presencia
      this.logger?.info('Cliente desconectado, pero usuario mantiene otros sockets', {
        match_id: matchId,
        user_id: client.userId,
        remaining_sockets: sockets.size,
      });
      return;
    }

    const session = await this.matchStore.getMatch(matchId);
    if (!session) return;

    const player = session.players.get(client.userId);
    if (!player) return;

    // Transición a 'reconnecting'
    player.connection = 'reconnecting';
    player.socket_id = undefined;
    session.state_version += 1;
    await this.matchStore.saveMatch(session);

    const roomName = matchRoom(matchId);
    const room = this.getRoom(roomName);
    if (room) {
      room.broadcast(S2C.PLAYER_STATUS, {
        match_id: matchId,
        user_id: client.userId,
        status: 'reconnecting',
        server_time: Date.now(),
      });
    }

    this.logger?.info('Jugador en periodo de gracia de reconexión', {
      match_id: matchId,
      user_id: client.userId,
      grace_ms: this.reconnectGraceMs,
    });

    // Iniciar timer de gracia
    const graceKey = `${matchId}:${client.userId}`;
    this.cancelGraceTimer(graceKey);

    const timer = setTimeout(() => {
      void this.expireReconnectGrace(matchId, client.userId);
    }, this.reconnectGraceMs);
    this.graceTimers.set(graceKey, timer);
  }

  // ─────────────────────── Difusión S2C desde el servidor ─────────────────

  /**
   * Difunde un veredicto a la sala de partida.
   *
   * Invariante doc 04 §86: `compile_output` solo se envía al dueño
   * del envío (`payload.user_id`). Los rivales reciben `compile_output: undefined`.
   */
  broadcastVerdict(matchId: string, payload: VerdictPayload): void {
    const roomName = matchRoom(matchId);
    const room = this.getRoom(roomName);
    if (!room) return;

    for (const [, client] of room.clients) {
      if (client.userId === payload.user_id) {
        // Dueño del envío: incluir compile_output
        client.emit(S2C.VERDICT, payload);
      } else {
        // Rival: omitir compile_output (doc 04 §86)
        const sanitized = { ...payload };
        delete sanitized.compile_output;
        client.emit(S2C.VERDICT, sanitized);
      }
    }

    this.logger?.info('Veredicto difundido', {
      match_id: matchId,
      submission_id: payload.submission_id,
      user_id: payload.user_id,
      verdict: payload.verdict,
    });
  }

  /**
   * Difunde actualización de puntajes a la sala de partida.
   */
  broadcastScoreUpdate(
    matchId: string,
    scores: PlayerScore[],
    stateVersion: number,
    roundId?: string,
  ): void {
    const roomName = matchRoom(matchId);
    const room = this.getRoom(roomName);
    if (!room) return;

    room.broadcast(S2C.SCORE_UPDATE, {
      match_id: matchId,
      state_version: stateVersion,
      server_time: Date.now(),
      scores,
      round_id: roundId,
    });
  }

  /**
   * Difunde el inicio de una partida a todos los jugadores en la sala.
   */
  broadcastMatchStarted(matchId: string, payload: MatchStartedPayload): void {
    const roomName = matchRoom(matchId);
    const room = this.getRoom(roomName);
    if (!room) return;

    room.broadcast(S2C.MATCH_STARTED, payload);

    this.logger?.info('Partida iniciada difundida', {
      match_id: matchId,
      mode: payload.mode,
      state_version: payload.state_version,
    });
  }

  /**
   * Difunde la finalización de una partida a todos los jugadores en la sala.
   */
  broadcastMatchFinished(matchId: string, payload: MatchFinishedPayload): void {
    const roomName = matchRoom(matchId);
    const room = this.getRoom(roomName);
    if (!room) return;

    room.broadcast(S2C.MATCH_FINISHED, payload);

    this.logger?.info('Partida finalizada difundida', {
      match_id: matchId,
      finish_reason: payload.finish_reason,
      winner_ids: payload.winner_ids,
      state_version: payload.state_version,
    });
  }

  // ─────────────────────── Métodos internos ───────────────────────────────

  /**
   * Construye un payload de MATCH_SYNC personalizado para un jugador.
   *
   * En modo Rondas, no expone `problem_order` para no revelar
   * problemas futuros (doc 04 §3).
   */
  private buildMatchSyncPayload(session: RealtimeMatchSession, userId: string): MatchSyncPayload {
    const revealFlags: Record<string, boolean> = {};
    const playersPresence: Record<string, SharedPlayerConnection> = {};

    for (const [id, p] of session.players) {
      revealFlags[id] = p.is_revealed;
      // Mapear estado interno 'reconnecting' al estado público 'disconnected'
      playersPresence[id] = p.connection === 'reconnecting' ? 'disconnected' : p.connection;
    }

    const player = session.players.get(userId);

    const payload: MatchSyncPayload = {
      match_id: session.match_id,
      state_version: session.state_version,
      server_time: Date.now(),
      status: session.status,
      mode: session.mode,
      round_id: session.current_round_id || null,
      problem_id: null, // Se resuelve por la lógica de rondas externa
      problem_index: player?.current_problem_idx ?? 0,
      ends_at: null, // Se resuelve por la lógica de rondas externa
      round_status: session.round_status || null,
      scores: session.scores,
      reveal_flags: revealFlags,
      players: playersPresence,
    };

    if (session.winner_ids) {
      payload.winner_ids = session.winner_ids;
    }

    return payload;
  }

  /**
   * Expira el periodo de gracia de reconexión:
   * si el usuario sigue sin sockets, marca presencia como 'disconnected'.
   */
  private async expireReconnectGrace(matchId: string, userId: string): Promise<void> {
    const graceKey = `${matchId}:${userId}`;
    this.graceTimers.delete(graceKey);

    // Verificar si reconectó durante la gracia
    const sockets = this.userSockets.get(userId);
    if (sockets && sockets.size > 0) {
      return; // Reconectó
    }

    const session = await this.matchStore.getMatch(matchId);
    if (!session) return;

    const player = session.players.get(userId);
    if (!player || player.connection !== 'reconnecting') return;

    player.connection = 'disconnected';
    session.state_version += 1;
    await this.matchStore.saveMatch(session);

    const roomName = matchRoom(matchId);
    const room = this.getRoom(roomName);
    if (room) {
      room.broadcast(S2C.PLAYER_STATUS, {
        match_id: matchId,
        user_id: userId,
        status: 'disconnected',
        server_time: Date.now(),
      });
    }

    this.logger?.info('Periodo de gracia expirado; jugador desconectado', {
      match_id: matchId,
      user_id: userId,
    });
  }

  /** Cancela un timer de gracia si existe. */
  private cancelGraceTimer(key: string): void {
    const timer = this.graceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(key);
    }
  }

  /** Limpia todos los timers de gracia (para apagado limpio). */
  clearAllGraceTimers(): void {
    for (const timer of this.graceTimers.values()) {
      clearTimeout(timer);
    }
    this.graceTimers.clear();
  }

  // ─────────────────────── Introspección (para pruebas) ───────────────────

  /** Número de clientes registrados. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Número de rooms activas. */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** Verifica si un usuario tiene sockets activos. */
  hasActiveSockets(userId: string): boolean {
    const sockets = this.userSockets.get(userId);
    return sockets !== undefined && sockets.size > 0;
  }
}
