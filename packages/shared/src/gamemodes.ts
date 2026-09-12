/**
 * Contratos de modos de juego puros (doc 03 § Límites de responsabilidad).
 *
 * Arquitectura de los modos de juego:
 * - Los modos de juego son funciones puras.
 * - Reciben un `MatchContext` inmutable que incluye `now` (epoch ms).
 * - Devuelven una lista de `ModeAction[]` para que el coordinador aplique transaccionalmente.
 * - NO acceden a sockets, base de datos, `Date.now()`, timers ni variables globales.
 */
import type {
  GameModeName,
  MatchConfig,
  MatchFinishReason,
  MatchStatus,
  PlayerConnection,
  PlayerScore,
  RoundStatus,
} from './events.js';
import type { Verdict } from './verdicts.js';

// ──────────────────────────────── Acciones ────────────────────────────────

export type ModeAction =
  | {
      type: 'award_score';
      user_id: string;
      round_id: string;
      score_delta: number;
      cases_delta: number;
      solve_elapsed_ms: number;
    }
  | {
      type: 'advance_round';
      next_problem_id: string;
      next_problem_index: number;
      next_round_id: string;
      ends_at: number;
    }
  | {
      type: 'advance_player';
      user_id: string;
      next_problem_id: string;
      next_problem_index: number;
      next_round_id: string;
      ends_at: number;
    }
  | {
      type: 'set_match_status';
      status: MatchStatus;
    }
  | {
      type: 'set_round_status';
      round_id: string;
      user_id?: string;
      status: RoundStatus;
    }
  | {
      type: 'finish_match';
      winner_ids: string[];
      winner_id: string | null;
      finish_reason: MatchFinishReason;
    }
  | {
      type: 'abandon_match';
      finish_reason: MatchFinishReason;
    };

// ──────────────────────────────── Contexto ────────────────────────────────

export interface RoundContext {
  round_id: string;
  problem_id: string;
  problem_index: number;
  status: RoundStatus;
  opened_at: number;
  ends_at: number;
  cutoff_at?: number | null;
  winner_id?: string | null;
  /** En Rondas, el ID del jugador dueño de esta ocurrencia individual. */
  user_id?: string;
}

export interface SubmissionVerdictContext {
  submission_id: string;
  user_id: string;
  round_id: string;
  problem_id: string;
  admission_seq: number;
  received_at: number;
  verdict: Verdict;
  passed_cases: number;
  total_cases: number;
  exec_time_ms: number;
}

export interface MatchContext {
  /** Timestamp absoluto de referencia para el cómputo puro (epoch ms). */
  readonly now: number;
  readonly match_id: string;
  readonly mode: GameModeName;
  readonly config: MatchConfig;
  readonly status: MatchStatus;
  readonly state_version: number;
  readonly scores: Readonly<Record<string, PlayerScore>>;
  readonly players: Readonly<Record<string, PlayerConnection>>;
  /** Lista ordenada y congelada de IDs de problemas asignados a la partida. */
  readonly problem_ids: readonly string[];
  /** Ronda global compartida (modo Puntos). */
  readonly current_round?: Readonly<RoundContext>;
  /** Rondas individuales indexadas por jugador (modo Rondas). */
  readonly player_rounds?: Readonly<Record<string, RoundContext>>;
}

/**
 * Contrato de la interfaz que implementan PuntosMode y RondasMode.
 */
export interface PureGameMode {
  readonly modeName: GameModeName;

  /** Determina las acciones al iniciar la partida (creación de primera ronda, etc.). */
  onMatchStart(ctx: MatchContext): ModeAction[];

  /** Procesa la llegada de un veredicto y decide adjudicación, cortes o avance. */
  onSubmissionVerdict(ctx: MatchContext, submission: SubmissionVerdictContext): ModeAction[];

  /** Evalúa el fin de tiempo de una ronda o de la partida completa. */
  onTimeout(ctx: MatchContext): ModeAction[];

  /** Procesa cambios en el estado de conexión o abandono de un jugador. */
  onPlayerStatusChange(
    ctx: MatchContext,
    userId: string,
    newStatus: PlayerConnection,
  ): ModeAction[];
}
