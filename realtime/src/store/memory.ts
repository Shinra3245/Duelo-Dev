import type { ConnectedPlayer, PlayerConnection, RealtimeMatchSession } from '../types.js';
import type { MatchStore } from './types.js';

function clonePlayer(player: ConnectedPlayer): ConnectedPlayer {
  return {
    user_id: player.user_id,
    gamertag: player.gamertag,
    connection: player.connection,
    ...(player.socket_id !== undefined ? { socket_id: player.socket_id } : {}),
    is_ready: player.is_ready,
    is_revealed: player.is_revealed,
    current_problem_idx: player.current_problem_idx,
    last_seen_at: player.last_seen_at,
  };
}

function cloneSession(session: RealtimeMatchSession): RealtimeMatchSession {
  const clonedPlayers = new Map<string, ConnectedPlayer>();
  for (const [userId, player] of session.players.entries()) {
    clonedPlayers.set(userId, clonePlayer(player));
  }

  return {
    match_id: session.match_id,
    room_code: session.room_code,
    mode: session.mode,
    config: JSON.parse(JSON.stringify(session.config)),
    status: session.status,
    round_status: session.round_status,
    current_round_id: session.current_round_id,
    current_round_idx: session.current_round_idx,
    state_version: session.state_version,
    players: clonedPlayers,
    scores: session.scores.map((score) => ({ ...score })),
    created_at: session.created_at,
    ...(session.started_at !== undefined ? { started_at: session.started_at } : {}),
    ...(session.instructions_ends_at !== undefined
      ? { instructions_ends_at: session.instructions_ends_at }
      : {}),
    ...(session.finished_at !== undefined ? { finished_at: session.finished_at } : {}),
    ...(session.winner_ids !== undefined ? { winner_ids: [...session.winner_ids] } : {}),
    ...(session.problem_ids !== undefined ? { problem_ids: [...session.problem_ids] } : {}),
    ...(session.round_opened_at !== undefined ? { round_opened_at: session.round_opened_at } : {}),
    ...(session.round_ends_at !== undefined ? { round_ends_at: session.round_ends_at } : {}),
    ...(session.match_ends_at !== undefined ? { match_ends_at: session.match_ends_at } : {}),
  };
}

/**
 * Implementación en memoria de MatchStore con clonación defensiva para pruebas y desarrollo.
 */
export class InMemoryMatchStore implements MatchStore {
  private readonly sessions = new Map<string, RealtimeMatchSession>();

  async getMatch(matchId: string): Promise<RealtimeMatchSession | null> {
    const session = this.sessions.get(matchId);
    if (!session) {
      return null;
    }
    return cloneSession(session);
  }

  async saveMatch(session: RealtimeMatchSession): Promise<void> {
    this.sessions.set(session.match_id, cloneSession(session));
  }

  async deleteMatch(matchId: string): Promise<void> {
    this.sessions.delete(matchId);
  }

  async setPlayerPresence(
    matchId: string,
    userId: string,
    connection: PlayerConnection,
    now: number = Date.now(),
  ): Promise<ConnectedPlayer | null> {
    const session = this.sessions.get(matchId);
    if (!session) {
      return null;
    }

    const player = session.players.get(userId);
    if (!player) {
      return null;
    }

    player.connection = connection;
    player.last_seen_at = now;
    return clonePlayer(player);
  }

  async countActiveMatches(): Promise<number> {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status !== 'finished' && session.status !== 'abandoned') {
        count++;
      }
    }
    return count;
  }

  async listActiveMatchIds(): Promise<string[]> {
    const activeIds: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.status !== 'finished' && session.status !== 'abandoned') {
        activeIds.push(session.match_id);
      }
    }
    return activeIds;
  }

  /**
   * Limpia todas las sesiones almacenadas en memoria.
   * Utilizado para aislamiento estricto en suites de prueba.
   */
  clear(): void {
    this.sessions.clear();
  }
}
