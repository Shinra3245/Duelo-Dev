/**
 * Catálogo tipado de eventos WebSocket (plan v2.0 §9 + añadidos del doc 05 §2).
 *
 * Esta es la ÚNICA definición. Ni `realtime/` ni `web/` escriben literales de
 * nombre de evento: importan estas constantes.
 */
import type { Verdict } from './verdicts.js';

export const MATCH_NAMESPACE = '/match';

/** Nombre de la room de Socket.io para una partida. */
export function matchRoom(matchId: string): string {
  return `match:${matchId}`;
}

// ─────────────────────────── Cliente → Servidor ───────────────────────────

export const C2S = {
  JOIN_MATCH: 'join_match',
  TOGGLE_REVEAL: 'toggle_reveal',
  READY: 'ready',
  HEARTBEAT: 'heartbeat',
} as const;

export interface ClientToServerEvents {
  [C2S.JOIN_MATCH]: (payload: { match_id: string }) => void;
  [C2S.TOGGLE_REVEAL]: (payload: { visible: boolean }) => void;
  [C2S.READY]: (payload: Record<string, never>) => void;
  [C2S.HEARTBEAT]: (payload: Record<string, never>) => void;
}

// ─────────────────────────── Servidor → Cliente ───────────────────────────

export const S2C = {
  MATCH_STARTED: 'match_started',
  MATCH_SYNC: 'match_sync',
  PROBLEM_BEGIN: 'problem_begin',
  SUBMISSION_RECEIVED: 'submission_received',
  VERDICT: 'verdict',
  SCORE_UPDATE: 'score_update',
  REVEAL_CHANGED: 'reveal_changed',
  PLAYER_STATUS: 'player_status',
  MATCH_FINISHED: 'match_finished',
  ERROR: 'error',
} as const;

export type MatchStatus = 'lobby' | 'running' | 'finished' | 'abandoned';
export type PlayerConnection = 'connected' | 'disconnected' | 'left';
export type GameModeName = 'puntos' | 'rondas';

/** Todo evento servidor→cliente lo lleva, para calibrar el desfase de reloj. */
export interface ServerStamped {
  server_time: number;
}

export interface PlayerScore {
  user_id: string;
  gamertag: string;
  score: number;
  cases_total: number;
  time_total_ms: number;
  current_problem_idx: number;
}

export interface MatchSyncPayload extends ServerStamped {
  match_id: string;
  status: MatchStatus;
  mode: GameModeName;
  problem_id: string | null;
  problem_index: number;
  /** Instante absoluto de fin, en epoch ms. El cronómetro se deriva de aquí. */
  ends_at: number | null;
  scores: PlayerScore[];
  reveal_flags: Record<string, boolean>;
  players: Record<string, PlayerConnection>;
}

export interface ServerToClientEvents {
  [S2C.MATCH_STARTED]: (
    p: ServerStamped & { mode: GameModeName; problem_order: string[]; config: MatchConfig },
  ) => void;
  [S2C.MATCH_SYNC]: (p: MatchSyncPayload) => void;
  [S2C.PROBLEM_BEGIN]: (
    p: ServerStamped & { problem_id: string; index: number; ends_at: number },
  ) => void;
  [S2C.SUBMISSION_RECEIVED]: (p: ServerStamped & { user_id: string }) => void;
  [S2C.VERDICT]: (
    p: ServerStamped & {
      user_id: string;
      submission_id: string;
      verdict: Verdict;
      passed: number;
      total: number;
      /** Solo se envía al dueño del envío, nunca al room (doc 05 §4). */
      compile_output?: string;
    },
  ) => void;
  [S2C.SCORE_UPDATE]: (p: ServerStamped & { scores: PlayerScore[] }) => void;
  [S2C.REVEAL_CHANGED]: (p: ServerStamped & { user_id: string; visible: boolean }) => void;
  [S2C.PLAYER_STATUS]: (p: ServerStamped & { user_id: string; status: PlayerConnection }) => void;
  [S2C.MATCH_FINISHED]: (
    p: ServerStamped & {
      winner_id: string | null;
      final_scores: PlayerScore[];
      summary_url: string;
    },
  ) => void;
  [S2C.ERROR]: (p: ServerStamped & { code: string; message: string }) => void;
}

/** Configuración de partida; se guarda en `matches.config` (JSONB). */
export interface MatchConfig {
  num_problems: number;
  time_per_problem_s: number;
  categories: ProblemCategory[];
  max_players: number;
  /** Solo RondasMode: hito de problemas resueltos para ganar. */
  target?: number;
  /** Solo PuntosMode: si nadie resuelve, ¿el punto va al que más casos pasó? */
  award_on_timeout?: boolean;
}

export type ProblemCategory = 'muy_facil' | 'facil' | 'facil_medio' | 'dificil';

/** Presupuesto de payload por evento (doc 05 §2). El código fuente viaja por Yjs. */
export const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024;
/** Límite de tamaño de un documento Yjs, defensa contra agotamiento de RAM (H12). */
export const MAX_YDOC_BYTES = 256 * 1024;
/** Gracia de reconexión antes de marcar a un jugador como desconectado (§9). */
export const RECONNECT_GRACE_MS = 60_000;
