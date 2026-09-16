/**
 * Orquestador de modos de juego puros (doc 03 § Límites de responsabilidad).
 *
 * Conecta los modos puros (`PureGameMode`) con las sesiones activas en memoria (`RealtimeMatchSession`),
 * construyendo el `MatchContext` inmutable y aplicando determinísticamente las `ModeAction[]`.
 */

import type {
  GameModeName,
  MatchContext,
  ModeAction,
  PlayerConnection as SharedPlayerConnection,
  PlayerScore,
  PureGameMode,
  RoundContext,
} from '@duelodev/shared';
import type { RealtimeMatchSession } from '../types.js';
import { PuntosMode } from './puntos.js';
import { RondasMode } from './rondas.js';

const puntosInstance = new PuntosMode();
const rondasInstance = new RondasMode();

/**
 * Obtiene la instancia del modo de juego puro según el nombre del modo.
 */
export function getGameMode(mode: GameModeName): PureGameMode {
  switch (mode) {
    case 'puntos':
      return puntosInstance;
    case 'rondas':
      return rondasInstance;
  }
}

export interface BuildMatchContextOptions {
  session: RealtimeMatchSession;
  problemIds: readonly string[];
  now?: number | undefined;
  currentRound?: RoundContext | undefined;
  playerRounds?: Record<string, RoundContext> | undefined;
}

/**
 * Construye un MatchContext inmutable a partir de una sesión activa.
 */
export function buildMatchContext(options: BuildMatchContextOptions): MatchContext {
  const { session, problemIds, now = Date.now(), currentRound, playerRounds } = options;

  const scoresRecord: Record<string, PlayerScore> = {};
  for (const s of session.scores) {
    scoresRecord[s.user_id] = { ...s };
  }

  const playersRecord: Record<string, SharedPlayerConnection> = {};
  for (const [userId, p] of session.players) {
    playersRecord[userId] = p.connection === 'reconnecting' ? 'disconnected' : p.connection;
  }

  const ctx: MatchContext = {
    now,
    match_id: session.match_id,
    mode: session.mode,
    config: session.config,
    status: session.status,
    state_version: session.state_version,
    scores: scoresRecord,
    players: playersRecord,
    problem_ids: problemIds,
  };

  if (currentRound) {
    return { ...ctx, current_round: currentRound };
  }

  if (playerRounds) {
    return { ...ctx, player_rounds: playerRounds };
  }

  return ctx;
}

/**
 * Aplica una lista de acciones emitidas por un modo de juego puro sobre una sesión de partida.
 * Incrementa la versión de estado (`state_version`) si hubo cambios efectivos.
 */
export function applyModeActions(
  session: RealtimeMatchSession,
  actions: readonly ModeAction[],
): { modified: boolean; session: RealtimeMatchSession } {
  if (actions.length === 0) {
    return { modified: false, session };
  }

  let modified = false;

  for (const action of actions) {
    switch (action.type) {
      case 'award_score': {
        const scoreIndex = session.scores.findIndex((s) => s.user_id === action.user_id);
        if (scoreIndex !== -1) {
          const prev = session.scores[scoreIndex]!;
          session.scores[scoreIndex] = {
            ...prev,
            score: prev.score + action.score_delta,
            cases_total: prev.cases_total + action.cases_delta,
            time_total_ms: prev.time_total_ms + action.solve_elapsed_ms,
          };
          modified = true;
        }
        break;
      }

      case 'advance_round': {
        session.current_round_id = action.next_round_id;
        session.current_round_idx = action.next_problem_index;
        // Avanzar índice para todos los participantes en Puntos
        for (const player of session.players.values()) {
          player.current_problem_idx = action.next_problem_index;
        }
        modified = true;
        break;
      }

      case 'advance_player': {
        const player = session.players.get(action.user_id);
        if (player) {
          player.current_problem_idx = action.next_problem_index;
        }
        const scoreEntry = session.scores.find((s) => s.user_id === action.user_id);
        if (scoreEntry) {
          scoreEntry.current_problem_idx = action.next_problem_index;
        }
        modified = true;
        break;
      }

      case 'set_match_status': {
        if (session.status !== action.status) {
          session.status = action.status;
          if (action.status === 'running' && !session.started_at) {
            session.started_at = new Date().toISOString();
          }
          modified = true;
        }
        break;
      }

      case 'set_round_status': {
        if (session.round_status !== action.status) {
          session.round_status = action.status;
          modified = true;
        }
        break;
      }

      case 'finish_match': {
        session.status = 'finished';
        session.winner_ids = [...action.winner_ids];
        session.finished_at = new Date().toISOString();
        modified = true;
        break;
      }

      case 'abandon_match': {
        session.status = 'abandoned';
        session.finished_at = new Date().toISOString();
        modified = true;
        break;
      }
    }
  }

  if (modified) {
    session.state_version += 1;
  }

  return { modified, session };
}
