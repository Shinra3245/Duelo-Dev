import type {
  GameModeName,
  Logger,
  MatchConfig,
  MatchStatus,
  PlayerScore,
  RoundStatus,
} from '@duelodev/shared';
import type { MatchStore } from './store/types.js';
import type { CodeSnapshot } from './yjs/types.js';

export type StructuredLogger = Logger;

export type PlayerConnection = 'connected' | 'reconnecting' | 'disconnected';

export interface ReadinessProbe {
  name: string;
  check: () => Promise<void>;
}

export interface ConnectedPlayer {
  user_id: string;
  gamertag: string;
  connection: PlayerConnection;
  socket_id?: string | undefined;
  is_ready: boolean;
  is_revealed: boolean;
  current_problem_idx: number;
  last_seen_at: number;
}

export interface RealtimeMatchSession {
  match_id: string;
  room_code: string;
  mode: GameModeName;
  config: MatchConfig;
  status: MatchStatus;
  round_status: RoundStatus;
  current_round_id: string;
  current_round_idx: number;
  state_version: number;
  players: Map<string, ConnectedPlayer>;
  scores: PlayerScore[];
  created_at: string;
  started_at?: string | undefined;
  finished_at?: string | undefined;
  winner_ids?: string[] | undefined;
  problem_ids?: string[] | undefined;
  round_opened_at?: number | undefined;
  round_ends_at?: number | undefined;
  match_ends_at?: number | undefined;
}

export interface RealtimeAppOptions {
  serviceName?: string | undefined;
  version?: string | undefined;
  matchStore?: MatchStore | undefined;
  readinessProbes?: ReadinessProbe[] | undefined;
  logger?: StructuredLogger | undefined;
  reconnectGraceMs?: number | undefined;
  yjsSnapshotIntervalMs?: number | undefined;
  onYjsSnapshotPersist?: ((snapshot: CodeSnapshot) => Promise<void>) | undefined;
  authSecret?: string | undefined;
}

export interface RealtimeContext {
  serviceName: string;
  version: string;
  matchStore: MatchStore;
  logger: StructuredLogger;
  startTime: number;
  readinessProbes: ReadinessProbe[];
  authSecret?: string | undefined;
}
