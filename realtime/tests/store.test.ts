import { describe, expect, it, beforeEach } from 'vitest';
import type { RealtimeMatchSession } from '../src/types.js';
import { InMemoryMatchStore } from '../src/store/memory.js';

function createSampleSession(
  matchId: string,
  status: RealtimeMatchSession['status'] = 'running',
): RealtimeMatchSession {
  const players = new Map();
  players.set('user-1', {
    user_id: 'user-1',
    gamertag: 'coder1',
    connection: 'connected' as const,
    is_ready: true,
    is_revealed: false,
    current_problem_idx: 0,
    last_seen_at: 1000,
  });

  return {
    match_id: matchId,
    room_code: 'ROOM01',
    mode: 'puntos',
    config: {
      mode: 'puntos',
      num_problems: 3,
      categories: ['facil', 'facil_medio'],
      max_players: 2,
      time_per_problem_s: 300,
    },
    status,
    round_status: 'open',
    current_round_id: 'round-1',
    current_round_idx: 0,
    state_version: 1,
    players,
    scores: [
      {
        user_id: 'user-1',
        gamertag: 'coder1',
        score: 0,
        cases_total: 0,
        time_total_ms: 0,
        current_problem_idx: 0,
      },
    ],
    created_at: new Date(1000).toISOString(),
  };
}

describe('InMemoryMatchStore', () => {
  let store: InMemoryMatchStore;

  beforeEach(() => {
    store = new InMemoryMatchStore();
  });

  it('guarda y recupera una sesión de partida correctamente', async () => {
    const session = createSampleSession('match-1');
    await store.saveMatch(session);

    const retrieved = await store.getMatch('match-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.match_id).toBe('match-1');
    expect(retrieved?.room_code).toBe('ROOM01');
    expect(retrieved?.players.get('user-1')?.gamertag).toBe('coder1');
    expect(retrieved?.scores[0]?.score).toBe(0);
  });

  it('retorna null cuando la partida no existe', async () => {
    const retrieved = await store.getMatch('non-existent');
    expect(retrieved).toBeNull();
  });

  it('aplica clonación defensiva al guardar (mutar objeto original no afecta el almacén)', async () => {
    const session = createSampleSession('match-1');
    await store.saveMatch(session);

    // Mutar el objeto original después de guardar
    session.room_code = 'MUTATED';
    session.players.get('user-1')!.gamertag = 'hacker';
    session.scores[0]!.score = 999;

    const stored = await store.getMatch('match-1');
    expect(stored?.room_code).toBe('ROOM01');
    expect(stored?.players.get('user-1')?.gamertag).toBe('coder1');
    expect(stored?.scores[0]?.score).toBe(0);
  });

  it('aplica clonación defensiva al recuperar (mutar retorno no afecta el almacén)', async () => {
    const session = createSampleSession('match-1');
    await store.saveMatch(session);

    const retrieved1 = await store.getMatch('match-1');
    expect(retrieved1).not.toBeNull();
    retrieved1!.room_code = 'MUTATED_AFTER_GET';
    retrieved1!.players.get('user-1')!.connection = 'disconnected';

    const retrieved2 = await store.getMatch('match-1');
    expect(retrieved2?.room_code).toBe('ROOM01');
    expect(retrieved2?.players.get('user-1')?.connection).toBe('connected');
  });

  it('elimina partidas correctamente', async () => {
    const session = createSampleSession('match-1');
    await store.saveMatch(session);

    await store.deleteMatch('match-1');
    const retrieved = await store.getMatch('match-1');
    expect(retrieved).toBeNull();
  });

  it('actualiza la presencia y conexión del jugador con setPlayerPresence', async () => {
    const session = createSampleSession('match-1');
    await store.saveMatch(session);

    const updated = await store.setPlayerPresence('match-1', 'user-1', 'reconnecting', 5000);
    expect(updated).not.toBeNull();
    expect(updated?.connection).toBe('reconnecting');
    expect(updated?.last_seen_at).toBe(5000);

    const retrieved = await store.getMatch('match-1');
    expect(retrieved?.players.get('user-1')?.connection).toBe('reconnecting');
    expect(retrieved?.players.get('user-1')?.last_seen_at).toBe(5000);

    // Actualizar a disconnected
    const disconnected = await store.setPlayerPresence('match-1', 'user-1', 'disconnected', 6000);
    expect(disconnected?.connection).toBe('disconnected');
    expect(disconnected?.last_seen_at).toBe(6000);
  });

  it('setPlayerPresence retorna null si la partida o el usuario no existen', async () => {
    const session = createSampleSession('match-1');
    await store.saveMatch(session);

    const noMatch = await store.setPlayerPresence('other-match', 'user-1', 'disconnected');
    expect(noMatch).toBeNull();

    const noUser = await store.setPlayerPresence('match-1', 'user-999', 'disconnected');
    expect(noUser).toBeNull();
  });

  it('cuenta partidas activas excluyendo finished y abandoned', async () => {
    expect(await store.countActiveMatches()).toBe(0);

    await store.saveMatch(createSampleSession('m-lobby', 'lobby'));
    await store.saveMatch(createSampleSession('m-running', 'running'));
    await store.saveMatch(createSampleSession('m-settling', 'settling'));
    await store.saveMatch(createSampleSession('m-finished', 'finished'));
    await store.saveMatch(createSampleSession('m-abandoned', 'abandoned'));

    // Solo lobby, running y settling son activas (3)
    expect(await store.countActiveMatches()).toBe(3);
  });

  it('limpia todas las partidas con clear()', async () => {
    await store.saveMatch(createSampleSession('match-1'));
    await store.saveMatch(createSampleSession('match-2'));
    expect(await store.countActiveMatches()).toBe(2);

    store.clear();
    expect(await store.countActiveMatches()).toBe(0);
    expect(await store.getMatch('match-1')).toBeNull();
    expect(await store.getMatch('match-2')).toBeNull();
  });

  it('clona defensivamente problem_ids y campos de temporización', async () => {
    const session = createSampleSession('match-timing');
    session.problem_ids = ['prob-1', 'prob-2'];
    session.round_opened_at = 1000;
    session.round_ends_at = 60000;
    session.match_ends_at = 300000;

    await store.saveMatch(session);

    // Mutar array original
    session.problem_ids.push('prob-mutated');
    session.round_opened_at = 9999;

    const retrieved = await store.getMatch('match-timing');
    expect(retrieved?.problem_ids).toEqual(['prob-1', 'prob-2']);
    expect(retrieved?.round_opened_at).toBe(1000);
    expect(retrieved?.round_ends_at).toBe(60000);
    expect(retrieved?.match_ends_at).toBe(300000);
  });
});
