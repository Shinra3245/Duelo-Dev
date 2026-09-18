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
  type ModeAction,
  type PlayerConnection as SharedPlayerConnection,
  type PlayerScore,
  type ProblemBeginPayload,
  type SubmissionVerdictContext,
  type VerdictPayload,
} from '@duelodev/shared';
import { applyModeActions, buildMatchContext, getGameMode } from '../gamemodes/orchestrator.js';
import type { MatchStore } from '../store/types.js';
import type { RealtimeMatchSession } from '../types.js';
import type { SocketClient, MatchRoom } from './types.js';
import { playerRoundId } from '../gamemodes/round-id.js';

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
  /** Timers de fin de ronda compartida (modo Puntos) indexados por matchId. */
  private readonly roundTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Timers de fin de partida global (modo Rondas) indexados por matchId. */
  private readonly matchTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  /**
   * Difunde un evento PROBLEM_BEGIN a toda la sala de partida (modo Puntos).
   */
  broadcastProblemBegin(matchId: string, payload: ProblemBeginPayload): void {
    const roomName = matchRoom(matchId);
    const room = this.getRoom(roomName);
    if (!room) return;

    room.broadcast(S2C.PROBLEM_BEGIN, payload);

    this.logger?.info('Inicio de problema difundido a la sala', {
      match_id: matchId,
      round_id: payload.round_id,
      problem_id: payload.problem_id,
      index: payload.index,
      ends_at: payload.ends_at,
    });
  }

  /**
   * Envía un evento PROBLEM_BEGIN exclusivamente a un usuario específico (modo Rondas).
   */
  sendProblemBeginToUser(matchId: string, userId: string, payload: ProblemBeginPayload): void {
    const socketIds = this.userSockets.get(userId);
    if (!socketIds) return;

    for (const socketId of socketIds) {
      const client = this.clients.get(socketId);
      if (client && client.matchId === matchId) {
        client.emit(S2C.PROBLEM_BEGIN, payload);
      }
    }

    this.logger?.info('Inicio de problema enviado a usuario individual', {
      match_id: matchId,
      user_id: userId,
      round_id: payload.round_id,
      problem_id: payload.problem_id,
      index: payload.index,
      ends_at: payload.ends_at,
    });
  }

  // ─────────────────────── Orquestación de modos de juego ─────────────────

  /**
   * Inicia una partida en tiempo real:
   * - Obtiene la sesión de matchStore. Si no existe o status !== 'lobby', retorna.
   * - Guarda session.problem_ids = [...problemIds].
   * - Obtiene mode = getGameMode(session.mode).
   * - Construye ctx = buildMatchContext({ session, problemIds, now: Date.now() }).
   * - Ejecuta actions = mode.onMatchStart(ctx).
   * - Aplica acciones con applyModeActions(session, actions).
   * - Guarda la sesión en matchStore.
   * - Difunde MATCH_STARTED (problem_order se incluye sólo en modo 'puntos', jamás en 'rondas').
   * - Si es Puntos: difunde PROBLEM_BEGIN para el problema 0 y programa scheduleRoundTimeout.
   * - Si es Rondas: envía PROBLEM_BEGIN a cada jugador para su problema 0 y programa scheduleMatchTimeout.
   */
  async startMatch(matchId: string, problemIds: string[]): Promise<void> {
    const session = await this.matchStore.getMatch(matchId);
    if (!session || session.status !== 'lobby') {
      return;
    }

    session.problem_ids = [...problemIds];
    const now = Date.now();
    const mode = getGameMode(session.mode);
    const ctx = buildMatchContext({ session, problemIds, now });
    const actions = mode.onMatchStart(ctx);

    applyModeActions(session, actions);
    await this.matchStore.saveMatch(session);

    // Difunde MATCH_STARTED (problem_order se incluye sólo en modo 'puntos', jamás en 'rondas')
    const matchStartedPayload: MatchStartedPayload = {
      match_id: matchId,
      state_version: session.state_version,
      server_time: now,
      mode: session.mode,
      round_id: session.current_round_id,
      config: session.config,
      ...(session.mode === 'puntos' ? { problem_order: [...problemIds] } : {}),
    };
    this.broadcastMatchStarted(matchId, matchStartedPayload);

    if (session.mode === 'puntos') {
      const advanceAction = actions.find(
        (a): a is Extract<ModeAction, { type: 'advance_round' }> => a.type === 'advance_round',
      );
      if (advanceAction) {
        const problemBeginPayload: ProblemBeginPayload = {
          match_id: matchId,
          state_version: session.state_version,
          server_time: now,
          round_id: advanceAction.next_round_id,
          problem_id: advanceAction.next_problem_id,
          index: advanceAction.next_problem_index,
          ends_at: advanceAction.ends_at,
        };
        this.broadcastProblemBegin(matchId, problemBeginPayload);
        this.scheduleRoundTimeout(matchId, advanceAction.ends_at - now);
      }
    } else if (session.mode === 'rondas') {
      const advancePlayers = actions.filter(
        (a): a is Extract<ModeAction, { type: 'advance_player' }> => a.type === 'advance_player',
      );
      let matchEndsAt: number | undefined;
      for (const act of advancePlayers) {
        matchEndsAt = act.ends_at;
        const problemBeginPayload: ProblemBeginPayload = {
          match_id: matchId,
          state_version: session.state_version,
          server_time: now,
          round_id: act.next_round_id,
          problem_id: act.next_problem_id,
          index: act.next_problem_index,
          ends_at: act.ends_at,
        };
        this.sendProblemBeginToUser(matchId, act.user_id, problemBeginPayload);
      }
      if (matchEndsAt !== undefined) {
        this.scheduleMatchTimeout(matchId, matchEndsAt - now);
      }
    }
  }

  /**
   * Procesa el veredicto de un envío evaluado por el juez:
   * - Difunde VERDICT con aislamiento estricto de compile_output (solo al autor).
   * - Ejecuta onSubmissionVerdict en el PureGameMode correspondiente.
   * - Aplica acciones y actualiza MatchStore.
   * - Si hubo award_score: difunde SCORE_UPDATE.
   * - Si hubo advance_round: cancela timeout previo de ronda, difunde PROBLEM_BEGIN y programa nuevo scheduleRoundTimeout.
   * - Si hubo advance_player: envía PROBLEM_BEGIN al jugador avanzado.
   * - Si hubo finish_match o abandon_match: cancela round y match timers y difunde MATCH_FINISHED.
   */
  async processSubmissionVerdict(
    matchId: string,
    submission: SubmissionVerdictContext,
    compileOutput?: string,
  ): Promise<void> {
    const session = await this.matchStore.getMatch(matchId);
    if (!session) return;

    const now = Date.now();

    // Difunde VERDICT con aislamiento estricto de compile_output (solo al autor)
    const verdictPayload: VerdictPayload = {
      match_id: matchId,
      round_id: submission.round_id,
      submission_id: submission.submission_id,
      user_id: submission.user_id,
      verdict: submission.verdict,
      passed: submission.passed_cases,
      total: submission.total_cases,
      exec_time_ms: submission.exec_time_ms,
      server_time: now,
      ...(compileOutput !== undefined ? { compile_output: compileOutput } : {}),
    };
    this.broadcastVerdict(matchId, verdictPayload);

    const mode = getGameMode(session.mode);
    const ctx = buildMatchContext({
      session,
      problemIds: session.problem_ids ?? [],
      now,
    });
    const actions = mode.onSubmissionVerdict(ctx, submission);
    if (actions.length === 0) return;

    applyModeActions(session, actions);
    await this.matchStore.saveMatch(session);

    // Si hubo award_score: difunde SCORE_UPDATE
    const hasAward = actions.some((a) => a.type === 'award_score');
    if (hasAward) {
      this.broadcastScoreUpdate(
        matchId,
        session.scores,
        session.state_version,
        session.current_round_id,
      );
    }

    // Si hubo advance_round: cancela timeout previo de ronda, difunde PROBLEM_BEGIN y programa nuevo scheduleRoundTimeout
    const advanceRound = actions.find(
      (a): a is Extract<ModeAction, { type: 'advance_round' }> => a.type === 'advance_round',
    );
    if (advanceRound) {
      this.cancelRoundTimeout(matchId);
      const problemBeginPayload: ProblemBeginPayload = {
        match_id: matchId,
        state_version: session.state_version,
        server_time: now,
        round_id: advanceRound.next_round_id,
        problem_id: advanceRound.next_problem_id,
        index: advanceRound.next_problem_index,
        ends_at: advanceRound.ends_at,
      };
      this.broadcastProblemBegin(matchId, problemBeginPayload);
      this.scheduleRoundTimeout(matchId, advanceRound.ends_at - now);
    }

    // Si hubo advance_player: envía PROBLEM_BEGIN al jugador avanzado
    const advancePlayers = actions.filter(
      (a): a is Extract<ModeAction, { type: 'advance_player' }> => a.type === 'advance_player',
    );
    for (const act of advancePlayers) {
      const problemBeginPayload: ProblemBeginPayload = {
        match_id: matchId,
        state_version: session.state_version,
        server_time: now,
        round_id: act.next_round_id,
        problem_id: act.next_problem_id,
        index: act.next_problem_index,
        ends_at: act.ends_at,
      };
      this.sendProblemBeginToUser(matchId, act.user_id, problemBeginPayload);
    }

    // Si hubo finish_match o abandon_match: cancela round y match timers y difunde MATCH_FINISHED
    const finishAct = actions.find(
      (a): a is Extract<ModeAction, { type: 'finish_match' | 'abandon_match' }> =>
        a.type === 'finish_match' || a.type === 'abandon_match',
    );
    if (finishAct) {
      this.cancelRoundTimeout(matchId);
      this.cancelMatchTimeout(matchId);

      const winnerIds = finishAct.type === 'finish_match' ? finishAct.winner_ids : [];
      const winnerId = finishAct.type === 'finish_match' ? finishAct.winner_id : null;
      const matchFinishedPayload: MatchFinishedPayload = {
        match_id: matchId,
        state_version: session.state_version,
        server_time: now,
        winner_ids: winnerIds,
        winner_id: winnerId,
        finish_reason: finishAct.finish_reason,
        final_scores: session.scores,
        summary_url: `/api/v1/matches/${matchId}/summary`,
      };
      this.broadcastMatchFinished(matchId, matchFinishedPayload);
    }
  }

  /**
   * Procesa la expiración de temporizador de ronda o partida:
   * - Ejecuta onTimeout en el modo correspondiente.
   * - Si hubo advance_round: difunde PROBLEM_BEGIN y programa nuevo timeout.
   * - Si hubo finish_match: cancela timers y difunde MATCH_FINISHED.
   */
  async processTimeout(matchId: string): Promise<void> {
    const session = await this.matchStore.getMatch(matchId);
    if (!session) return;

    const now = Date.now();
    const ctx = buildMatchContext({
      session,
      problemIds: session.problem_ids ?? [],
      now,
    });
    const mode = getGameMode(session.mode);
    const actions = mode.onTimeout(ctx);
    if (actions.length === 0) return;

    applyModeActions(session, actions);
    await this.matchStore.saveMatch(session);

    // Si hubo advance_round: difunde PROBLEM_BEGIN y programa nuevo timeout
    const advanceRound = actions.find(
      (a): a is Extract<ModeAction, { type: 'advance_round' }> => a.type === 'advance_round',
    );
    if (advanceRound) {
      this.cancelRoundTimeout(matchId);
      const problemBeginPayload: ProblemBeginPayload = {
        match_id: matchId,
        state_version: session.state_version,
        server_time: now,
        round_id: advanceRound.next_round_id,
        problem_id: advanceRound.next_problem_id,
        index: advanceRound.next_problem_index,
        ends_at: advanceRound.ends_at,
      };
      this.broadcastProblemBegin(matchId, problemBeginPayload);
      this.scheduleRoundTimeout(matchId, advanceRound.ends_at - now);
    }

    // Si hubo finish_match o abandon_match: cancela timers y difunde MATCH_FINISHED
    const finishAct = actions.find(
      (a): a is Extract<ModeAction, { type: 'finish_match' | 'abandon_match' }> =>
        a.type === 'finish_match' || a.type === 'abandon_match',
    );
    if (finishAct) {
      this.cancelRoundTimeout(matchId);
      this.cancelMatchTimeout(matchId);

      const winnerIds = finishAct.type === 'finish_match' ? finishAct.winner_ids : [];
      const winnerId = finishAct.type === 'finish_match' ? finishAct.winner_id : null;
      const matchFinishedPayload: MatchFinishedPayload = {
        match_id: matchId,
        state_version: session.state_version,
        server_time: now,
        winner_ids: winnerIds,
        winner_id: winnerId,
        finish_reason: finishAct.finish_reason,
        final_scores: session.scores,
        summary_url: `/api/v1/matches/${matchId}/summary`,
      };
      this.broadcastMatchFinished(matchId, matchFinishedPayload);
    }
  }

  // ─────────────────────── Gestión de temporizadores de juego ────────────

  /** Programa un timer para el fin de ronda compartida (modo Puntos). */
  scheduleRoundTimeout(matchId: string, durationMs: number): void {
    this.cancelRoundTimeout(matchId);
    const delay = Math.max(0, durationMs);
    const timer = setTimeout(() => {
      this.roundTimers.delete(matchId);
      void this.processTimeout(matchId);
    }, delay);
    this.roundTimers.set(matchId, timer);
  }

  /** Cancela el timer de ronda compartida para una partida si existe. */
  cancelRoundTimeout(matchId: string): void {
    const timer = this.roundTimers.get(matchId);
    if (timer) {
      clearTimeout(timer);
      this.roundTimers.delete(matchId);
    }
  }

  /** Programa un timer para el fin global de la partida (modo Rondas). */
  scheduleMatchTimeout(matchId: string, durationMs: number): void {
    this.cancelMatchTimeout(matchId);
    const delay = Math.max(0, durationMs);
    const timer = setTimeout(() => {
      this.matchTimers.delete(matchId);
      void this.processTimeout(matchId);
    }, delay);
    this.matchTimers.set(matchId, timer);
  }

  /** Cancela el timer de fin global para una partida si existe. */
  cancelMatchTimeout(matchId: string): void {
    const timer = this.matchTimers.get(matchId);
    if (timer) {
      clearTimeout(timer);
      this.matchTimers.delete(matchId);
    }
  }

  /** Limpia todos los temporizadores (gracia, rondas y partidas). */
  clearAllTimers(): void {
    this.clearAllGraceTimers();
    for (const timer of this.roundTimers.values()) {
      clearTimeout(timer);
    }
    this.roundTimers.clear();
    for (const timer of this.matchTimers.values()) {
      clearTimeout(timer);
    }
    this.matchTimers.clear();
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

    let roundId: string | null = session.current_round_id || null;
    let problemId: string | null = null;
    let problemIndex = player?.current_problem_idx ?? 0;
    let endsAt: number | null = null;

    if (session.mode === 'puntos') {
      problemIndex = session.current_round_idx;
      problemId = session.problem_ids ? (session.problem_ids[problemIndex] ?? null) : null;
      endsAt = session.round_ends_at ?? null;
    } else if (session.mode === 'rondas') {
      problemIndex = player?.current_problem_idx ?? 0;
      roundId =
        session.status === 'lobby'
          ? session.current_round_id || null
          : playerRoundId(session.match_id, userId, problemIndex);
      problemId = session.problem_ids ? (session.problem_ids[problemIndex] ?? null) : null;
      endsAt = session.match_ends_at ?? session.round_ends_at ?? null;
    }

    const payload: MatchSyncPayload = {
      match_id: session.match_id,
      state_version: session.state_version,
      server_time: Date.now(),
      status: session.status,
      mode: session.mode,
      round_id: roundId,
      problem_id: problemId,
      problem_index: problemIndex,
      ends_at: endsAt,
      round_status: session.round_status || null,
      scores: session.scores,
      reveal_flags: revealFlags,
      players: playersPresence,
    };

    if (session.winner_ids) {
      payload.winner_ids = session.winner_ids;
      payload.winner_id = session.winner_ids.length === 1 ? session.winner_ids[0]! : null;
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

    const now = Date.now();
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
        server_time: now,
      });
    }

    this.logger?.info('Periodo de gracia expirado; jugador desconectado', {
      match_id: matchId,
      user_id: userId,
    });

    const mode = getGameMode(session.mode);
    const ctx = buildMatchContext({
      session,
      problemIds: session.problem_ids ?? [],
      now,
    });
    const actions = mode.onPlayerStatusChange(ctx, userId, 'disconnected');
    if (actions.length > 0) {
      applyModeActions(session, actions);
      await this.matchStore.saveMatch(session);

      const finishAct = actions.find(
        (a): a is Extract<ModeAction, { type: 'finish_match' | 'abandon_match' }> =>
          a.type === 'finish_match' || a.type === 'abandon_match',
      );
      if (finishAct) {
        this.cancelRoundTimeout(matchId);
        this.cancelMatchTimeout(matchId);

        const winnerIds = finishAct.type === 'finish_match' ? finishAct.winner_ids : [];
        const winnerId = finishAct.type === 'finish_match' ? finishAct.winner_id : null;
        const matchFinishedPayload: MatchFinishedPayload = {
          match_id: matchId,
          state_version: session.state_version,
          server_time: now,
          winner_ids: winnerIds,
          winner_id: winnerId,
          finish_reason: finishAct.finish_reason,
          final_scores: session.scores,
          summary_url: `/api/v1/matches/${matchId}/summary`,
        };
        this.broadcastMatchFinished(matchId, matchFinishedPayload);
      }
    }
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

  /** Lista los identificadores de partidas con salas activas. */
  getActiveMatchIds(): string[] {
    const ids: string[] = [];
    for (const name of this.rooms.keys()) {
      if (name.startsWith('match:')) {
        ids.push(name.slice(6));
      }
    }
    return ids;
  }
}
