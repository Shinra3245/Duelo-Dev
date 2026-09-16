import { describe, expect, it } from 'vitest';
import type { ModeAction } from '@duelodev/shared';
import { applyModeActions, buildMatchContext, getGameMode } from '../src/gamemodes/orchestrator.js';
import { PuntosMode } from '../src/gamemodes/puntos.js';
import { RondasMode } from '../src/gamemodes/rondas.js';
import type { RealtimeMatchSession } from '../src/types.js';

function createSampleSession(): RealtimeMatchSession {
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
    match_id: 'm1',
    room_code: 'ROOM01',
    mode: 'puntos',
    config: {
      mode: 'puntos',
      num_problems: 3,
      categories: ['facil'],
      max_players: 2,
      time_per_problem_s: 300,
    },
    status: 'running',
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

describe('Gamemodes Orchestrator', () => {
  describe('getGameMode', () => {
    it('retorna PuntosMode para modo puntos', () => {
      const mode = getGameMode('puntos');
      expect(mode).toBeInstanceOf(PuntosMode);
      expect(mode.modeName).toBe('puntos');
    });

    it('retorna RondasMode para modo rondas', () => {
      const mode = getGameMode('rondas');
      expect(mode).toBeInstanceOf(RondasMode);
      expect(mode.modeName).toBe('rondas');
    });
  });

  describe('buildMatchContext', () => {
    it('construye MatchContext fielmente a partir de una sesión', () => {
      const session = createSampleSession();
      const ctx = buildMatchContext({
        session,
        problemIds: ['p1', 'p2', 'p3'],
        now: 5000,
      });

      expect(ctx.now).toBe(5000);
      expect(ctx.match_id).toBe('m1');
      expect(ctx.mode).toBe('puntos');
      expect(ctx.scores['user-1']?.gamertag).toBe('coder1');
      expect(ctx.players['user-1']).toBe('connected');
      expect(ctx.problem_ids).toEqual(['p1', 'p2', 'p3']);
    });
  });

  describe('applyModeActions', () => {
    it('retorna modified false si la lista de acciones está vacía', () => {
      const session = createSampleSession();
      const res = applyModeActions(session, []);
      expect(res.modified).toBe(false);
      expect(session.state_version).toBe(1);
    });

    it('aplica award_score e incrementa state_version', () => {
      const session = createSampleSession();
      const actions: ModeAction[] = [
        {
          type: 'award_score',
          user_id: 'user-1',
          round_id: 'round-1',
          score_delta: 1,
          cases_delta: 10,
          solve_elapsed_ms: 1500,
        },
      ];

      const res = applyModeActions(session, actions);
      expect(res.modified).toBe(true);
      expect(session.scores[0]?.score).toBe(1);
      expect(session.scores[0]?.cases_total).toBe(10);
      expect(session.scores[0]?.time_total_ms).toBe(1500);
      expect(session.state_version).toBe(2);
    });

    it('aplica advance_round actualizando la ronda y el índice de los jugadores', () => {
      const session = createSampleSession();
      const actions: ModeAction[] = [
        {
          type: 'advance_round',
          next_problem_id: 'p2',
          next_problem_index: 1,
          next_round_id: 'round-2',
          ends_at: 60000,
        },
      ];

      const res = applyModeActions(session, actions);
      expect(res.modified).toBe(true);
      expect(session.current_round_id).toBe('round-2');
      expect(session.current_round_idx).toBe(1);
      expect(session.players.get('user-1')?.current_problem_idx).toBe(1);
    });

    it('aplica advance_player actualizando solo al jugador especificado', () => {
      const session = createSampleSession();
      const actions: ModeAction[] = [
        {
          type: 'advance_player',
          user_id: 'user-1',
          next_problem_id: 'p2',
          next_problem_index: 1,
          next_round_id: 'round-u-1-2',
          ends_at: 60000,
        },
      ];

      const res = applyModeActions(session, actions);
      expect(res.modified).toBe(true);
      expect(session.players.get('user-1')?.current_problem_idx).toBe(1);
      expect(session.scores[0]?.current_problem_idx).toBe(1);
      expect(session.round_ends_at).toBe(60000);
      expect(session.match_ends_at).toBe(60000);
    });

    it('aplica advance_round actualizando tiempos de apertura y fin de ronda', () => {
      const session = createSampleSession();
      const actions: ModeAction[] = [
        {
          type: 'advance_round',
          next_problem_id: 'p2',
          next_problem_index: 1,
          next_round_id: 'round-2',
          ends_at: 360000,
        },
      ];

      const res = applyModeActions(session, actions);
      expect(res.modified).toBe(true);
      expect(session.round_ends_at).toBe(360000);
      // time_per_problem_s = 300 s -> 300,000 ms. 360,000 - 300,000 = 60,000
      expect(session.round_opened_at).toBe(60000);
    });

    it('aplica finish_match y abandon_match actualizando estados, timestamps y round_status closed', () => {
      const session1 = createSampleSession();
      applyModeActions(session1, [
        {
          type: 'finish_match',
          winner_ids: ['user-1'],
          winner_id: 'user-1',
          finish_reason: 'problems_exhausted',
        },
      ]);
      expect(session1.status).toBe('finished');
      expect(session1.round_status).toBe('closed');
      expect(session1.winner_ids).toEqual(['user-1']);
      expect(session1.finished_at).toBeDefined();

      const session2 = createSampleSession();
      applyModeActions(session2, [
        {
          type: 'abandon_match',
          finish_reason: 'all_players_left',
        },
      ]);
      expect(session2.status).toBe('abandoned');
      expect(session2.round_status).toBe('closed');
      expect(session2.finished_at).toBeDefined();
    });
  });

  describe('buildMatchContext auto-resolución', () => {
    it('construye automáticamente current_round en modo puntos si no es provisto', () => {
      const session = createSampleSession();
      session.round_opened_at = 10000;
      session.round_ends_at = 70000;
      session.current_round_id = 'round-puntos-1';
      session.current_round_idx = 0;

      const ctx = buildMatchContext({
        session,
        problemIds: ['p-10', 'p-20'],
        now: 15000,
      });

      expect(ctx.current_round).toBeDefined();
      expect(ctx.current_round?.round_id).toBe('round-puntos-1');
      expect(ctx.current_round?.problem_id).toBe('p-10');
      expect(ctx.current_round?.problem_index).toBe(0);
      expect(ctx.current_round?.status).toBe('open');
      expect(ctx.current_round?.opened_at).toBe(10000);
      expect(ctx.current_round?.ends_at).toBe(70000);
    });

    it('construye automáticamente player_rounds en modo rondas para cada jugador', () => {
      const session = createSampleSession();
      session.mode = 'rondas';
      session.config = {
        mode: 'rondas',
        num_problems: 5,
        categories: ['facil'],
        max_players: 2,
        match_duration_s: 600,
        target: 3,
      };
      session.match_ends_at = 600000;
      session.players.set('user-2', {
        user_id: 'user-2',
        gamertag: 'coder2',
        connection: 'connected',
        is_ready: true,
        is_revealed: false,
        current_problem_idx: 1,
        last_seen_at: 1000,
      });

      const ctx = buildMatchContext({
        session,
        problemIds: ['p-1', 'p-2', 'p-3'],
        now: 5000,
      });

      expect(ctx.player_rounds).toBeDefined();
      expect(ctx.player_rounds?.['user-1']?.round_id).toBe('round-u-user-1-1');
      expect(ctx.player_rounds?.['user-1']?.problem_id).toBe('p-1');
      expect(ctx.player_rounds?.['user-1']?.problem_index).toBe(0);
      expect(ctx.player_rounds?.['user-1']?.ends_at).toBe(600000);

      expect(ctx.player_rounds?.['user-2']?.round_id).toBe('round-u-user-2-2');
      expect(ctx.player_rounds?.['user-2']?.problem_id).toBe('p-2');
      expect(ctx.player_rounds?.['user-2']?.problem_index).toBe(1);
      expect(ctx.player_rounds?.['user-2']?.ends_at).toBe(600000);
    });
  });
});
