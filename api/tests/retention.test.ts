import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { isValidGamertag, type MatchSummaryResponse } from '@duelodev/shared';
import { AUTH_COOKIE_NAMES } from '../src/plugins/cookies.js';
import {
  InMemoryRefreshTokenRepository,
  InMemoryRoomRepository,
  InMemoryUserRepository,
} from '../src/repositories/memory.js';
import { RetentionService, generateTombstoneGamertag } from '../src/services/retention.js';
import { createApp } from '../src/app.js';

describe('Servicio de Retención y Purga de Invitados (doc 04 §5, doc 06 §B04)', () => {
  describe('generateTombstoneGamertag', () => {
    it('genera gamertags válidos según GAMERTAG_REGEX con prefijo por defecto', () => {
      const gamertag = generateTombstoneGamertag('550e8400-e29b-41d4-a716-446655440000');
      expect(isValidGamertag(gamertag)).toBe(true);
      expect(gamertag.startsWith('anon-')).toBe(true);
      expect(gamertag.length).toBeGreaterThanOrEqual(3);
      expect(gamertag.length).toBeLessThanOrEqual(20);
    });

    it('soporta prefijos personalizados y respeta longitud máxima', () => {
      const gamertag = generateTombstoneGamertag('user-12345', 'ghost');
      expect(isValidGamertag(gamertag)).toBe(true);
      expect(gamertag.startsWith('ghost-')).toBe(true);
      expect(gamertag.length).toBeLessThanOrEqual(20);
    });

    it('maneja identificadores inusuales o vacíos garantizando validez', () => {
      const tagEmpty = generateTombstoneGamertag('');
      expect(isValidGamertag(tagEmpty)).toBe(true);

      const tagSymbols = generateTombstoneGamertag('$$--##!!');
      expect(isValidGamertag(tagSymbols)).toBe(true);
    });
  });

  describe('Repositorios en memoria - Métodos de Retención', () => {
    it('InMemoryUserRepository.findInactiveGuests filtra correctamente por rol y fecha de inactividad', async () => {
      const userRepo = new InMemoryUserRepository();
      const now = Date.now();
      const oldDate = new Date(now - 40 * 86_400_000).toISOString();
      const recentDate = new Date(now - 10 * 86_400_000).toISOString();
      const cutoff = new Date(now - 30 * 86_400_000).toISOString();

      // Guest inactivo (debe incluirse)
      const guestOld = await userRepo.create({
        gamertag: 'guest-old',
        role: 'guest',
        updated_at: oldDate,
      });

      // Guest reciente (no debe incluirse)
      await userRepo.create({
        gamertag: 'guest-recent',
        role: 'guest',
        updated_at: recentDate,
      });

      // Usuario registrado antiguo (no debe incluirse porque role === 'user')
      await userRepo.create({
        gamertag: 'user-old',
        email: 'userold@example.com',
        role: 'user',
        updated_at: oldDate,
      });

      const inactive = await userRepo.findInactiveGuests(cutoff);
      expect(inactive).toHaveLength(1);
      expect(inactive[0]?.id).toBe(guestOld.id);
    });

    it('InMemoryUserRepository.anonymizeGuest anonimiza datos personales y preserva id', async () => {
      const userRepo = new InMemoryUserRepository();
      const user = await userRepo.create({
        gamertag: 'initial-guest',
        email: 'guest@temp.com',
        password_hash: 'somehash',
        role: 'guest',
      });

      const tombstone = 'anon-tombstone';
      const updated = await userRepo.anonymizeGuest(user.id, tombstone, '2026-09-15T00:00:00.000Z');

      expect(updated).not.toBeNull();
      expect(updated?.id).toBe(user.id);
      expect(updated?.gamertag).toBe(tombstone);
      expect(updated?.email).toBeNull();
      expect(updated?.password_hash).toBeNull();
      expect(updated?.updated_at).toBe('2026-09-15T00:00:00.000Z');

      // Consultar de nuevo para verificar persistencia
      const reloaded = await userRepo.findById(user.id);
      expect(reloaded?.gamertag).toBe(tombstone);
      expect(reloaded?.email).toBeNull();
    });

    it('InMemoryRefreshTokenRepository.revokeAllForUser revoca todas las sesiones activas del usuario', async () => {
      const tokenRepo = new InMemoryRefreshTokenRepository();
      const userId = 'target-user';
      const otherUserId = 'other-user';

      await tokenRepo.create({
        user_id: userId,
        token_hash: 'hash-1',
        family_id: 'fam-1',
        expires_at: new Date(Date.now() + 10000).toISOString(),
      });
      await tokenRepo.create({
        user_id: userId,
        token_hash: 'hash-2',
        family_id: 'fam-2',
        expires_at: new Date(Date.now() + 10000).toISOString(),
      });
      await tokenRepo.create({
        user_id: otherUserId,
        token_hash: 'hash-3',
        family_id: 'fam-3',
        expires_at: new Date(Date.now() + 10000).toISOString(),
      });

      const revokedCount = await tokenRepo.revokeAllForUser(userId);
      expect(revokedCount).toBe(2);

      // Si se invoca nuevamente, no vuelve a revocar los ya revocados
      const secondCall = await tokenRepo.revokeAllForUser(userId);
      expect(secondCall).toBe(0);

      // El token del otro usuario no se vio afectado
      const otherToken = await tokenRepo.findByTokenHash('hash-3');
      expect(otherToken?.revoked).toBe(false);
    });

    it('InMemoryRoomRepository.deleteSnapshotsByUser respeta consentimientos de revelado', async () => {
      const roomRepo = new InMemoryRoomRepository();
      const match1 = await roomRepo.createMatch({
        room_code: 'ROOM1',
        mode: 'puntos',
        config: { max_players: 2, problems_count: 1, round_duration_s: 300 },
        host_id: 'host1',
      });
      const match2 = await roomRepo.createMatch({
        room_code: 'ROOM2',
        mode: 'puntos',
        config: { max_players: 2, problems_count: 1, round_duration_s: 300 },
        host_id: 'host2',
      });

      const userId = 'guest-user';
      const otherUserId = 'other-user';

      // En match1, el jugador NO consintió revelar código (is_revealed: false)
      await roomRepo.addPlayer({
        match_id: match1.id,
        user_id: userId,
        is_revealed: false,
      });

      // En match2, el jugador SÍ consintió revelar código (is_revealed: true)
      await roomRepo.addPlayer({
        match_id: match2.id,
        user_id: userId,
        is_revealed: true,
      });

      // Snapshots del usuario en match1 y match2
      await roomRepo.saveSnapshot({
        match_id: match1.id,
        round_id: 'r1',
        user_id: userId,
        problem_id: 'p1',
        language: 'typescript',
        source_code: 'code match 1',
      });
      await roomRepo.saveSnapshot({
        match_id: match2.id,
        round_id: 'r2',
        user_id: userId,
        problem_id: 'p2',
        language: 'typescript',
        source_code: 'code match 2 (revealed)',
      });

      // Snapshot de otro usuario en match1
      await roomRepo.saveSnapshot({
        match_id: match1.id,
        round_id: 'r1',
        user_id: otherUserId,
        problem_id: 'p1',
        language: 'typescript',
        source_code: 'other user code',
      });

      // Purgar únicamente snapshots no revelados (onlyUnrevealed = true)
      const scrubbed = await roomRepo.deleteSnapshotsByUser(userId, true);
      expect(scrubbed).toBe(1);

      // El snapshot no revelado en match1 fue eliminado
      const match1Snaps = await roomRepo.findSnapshotsByMatch(match1.id);
      expect(match1Snaps).toHaveLength(1);
      expect(match1Snaps[0]?.user_id).toBe(otherUserId);

      // El snapshot revelado en match2 se conservó
      const match2Snaps = await roomRepo.findSnapshotsByMatch(match2.id);
      expect(match2Snaps).toHaveLength(1);
      expect(match2Snaps[0]?.user_id).toBe(userId);

      // Si llamamos con onlyUnrevealed = false, elimina todos los del usuario
      const scrubbedAll = await roomRepo.deleteSnapshotsByUser(userId, false);
      expect(scrubbedAll).toBe(1);

      const match2SnapsAfter = await roomRepo.findSnapshotsByMatch(match2.id);
      expect(match2SnapsAfter).toHaveLength(0);
    });
  });

  describe('RetentionService', () => {
    it('vacía sólo el código de snapshots terminales vencidos y conserva el historial', async () => {
      const userRepo = new InMemoryUserRepository();
      const refreshTokenRepo = new InMemoryRefreshTokenRepository();
      const roomRepo = new InMemoryRoomRepository();
      const service = new RetentionService(userRepo, refreshTokenRepo, roomRepo);
      const snapshots = new Map<string, string>();
      const testUserId = 'retention-player';

      const oldFinished = await roomRepo.createMatch({
        room_code: 'OLD001',
        mode: 'puntos',
        status: 'finished',
        finished_at: '2026-08-01T12:00:00.000Z',
        config: { max_players: 2, problems_count: 1, round_duration_s: 300 },
        host_id: testUserId,
      });
      const oldAbandoned = await roomRepo.createMatch({
        room_code: 'OLD002',
        mode: 'puntos',
        status: 'abandoned',
        finished_at: '2026-08-01T12:00:00.000Z',
        config: { max_players: 2, problems_count: 1, round_duration_s: 300 },
        host_id: testUserId,
      });
      const recentFinished = await roomRepo.createMatch({
        room_code: 'NEW001',
        mode: 'puntos',
        status: 'finished',
        finished_at: '2026-09-01T12:00:00.000Z',
        config: { max_players: 2, problems_count: 1, round_duration_s: 300 },
        host_id: testUserId,
      });
      const activeMatch = await roomRepo.createMatch({
        room_code: 'LIVE01',
        mode: 'puntos',
        status: 'running',
        config: { max_players: 2, problems_count: 1, round_duration_s: 300 },
        host_id: testUserId,
      });

      for (const match of [oldFinished, oldAbandoned, recentFinished, activeMatch]) {
        const snapshot = await roomRepo.saveSnapshot({
          match_id: match.id,
          round_id: 'retention-round',
          user_id: testUserId,
          problem_id: 'retention-problem',
          language: 'python',
          source_code: `private code ${match.room_code}`,
        });
        snapshots.set(match.id, snapshot.id);
      }

      const result = await service.purgeExpiredMatchCodeSnapshots(
        new Date('2026-09-15T12:00:00.000Z'),
      );

      expect(result.cutoff_iso).toBe('2026-08-16T12:00:00.000Z');
      expect(result.scrubbed_snapshots).toBe(2);
      for (const match of [oldFinished, oldAbandoned]) {
        const retained = await roomRepo.findSnapshotsByMatch(match.id);
        expect(retained).toHaveLength(1);
        expect(retained[0]).toMatchObject({ id: snapshots.get(match.id), source_code: '' });
        expect(await roomRepo.findMatchById(match.id)).not.toBeNull();
      }
      for (const match of [recentFinished, activeMatch]) {
        const retained = await roomRepo.findSnapshotsByMatch(match.id);
        expect(retained[0]?.source_code).toBe(`private code ${match.room_code}`);
      }

      const repeated = await service.purgeExpiredMatchCodeSnapshots(
        new Date('2026-09-15T12:00:00.000Z'),
      );
      expect(repeated.scrubbed_snapshots).toBe(0);
    });

    it('purgeInactiveGuests purga adecuadamente cuentas guest con más de 30 días de inactividad', async () => {
      const userRepo = new InMemoryUserRepository();
      const refreshTokenRepo = new InMemoryRefreshTokenRepository();
      const roomRepo = new InMemoryRoomRepository();

      const service = new RetentionService(userRepo, refreshTokenRepo, roomRepo);
      const now = new Date('2026-09-15T12:00:00.000Z');

      // Guest inactivo (hace 35 días)
      const inactiveGuest = await userRepo.create({
        gamertag: 'guest-inactive',
        email: 'temp@guest.local',
        role: 'guest',
        updated_at: new Date('2026-08-10T12:00:00.000Z').toISOString(),
      });

      // Token de sesión para el guest inactivo
      await refreshTokenRepo.create({
        user_id: inactiveGuest.id,
        token_hash: 'token-guest-inactive',
        family_id: 'fam-guest',
        expires_at: new Date('2026-10-01T00:00:00.000Z').toISOString(),
      });

      // Partida con snapshot no revelado para el guest inactivo
      const match = await roomRepo.createMatch({
        room_code: 'RET01',
        mode: 'puntos',
        config: { max_players: 2, problems_count: 1, round_duration_s: 300 },
        host_id: inactiveGuest.id,
      });
      await roomRepo.addPlayer({
        match_id: match.id,
        user_id: inactiveGuest.id,
        is_revealed: false,
      });
      await roomRepo.saveSnapshot({
        match_id: match.id,
        round_id: 'r1',
        user_id: inactiveGuest.id,
        problem_id: 'p1',
        language: 'python',
        source_code: 'secret draft code',
      });

      // Guest activo (hace 5 días)
      const activeGuest = await userRepo.create({
        gamertag: 'guest-active',
        role: 'guest',
        updated_at: new Date('2026-09-10T12:00:00.000Z').toISOString(),
      });

      // Usuario registrado inactivo (no debe purgarse)
      const registeredUser = await userRepo.create({
        gamertag: 'registered-old',
        email: 'user@duelodev.com',
        password_hash: 'hashedpassword',
        role: 'user',
        updated_at: new Date('2026-07-01T00:00:00.000Z').toISOString(),
      });

      const result = await service.purgeInactiveGuests(now);

      expect(result.scanned_guests).toBe(1);
      expect(result.purged_guests).toBe(1);
      expect(result.revoked_sessions).toBe(1);
      expect(result.scrubbed_snapshots).toBe(1);
      expect(result.purged_user_ids).toEqual([inactiveGuest.id]);

      // Verificar que el guest inactivo fue tombstoned
      const purgedUser = await userRepo.findById(inactiveGuest.id);
      expect(purgedUser?.gamertag).toMatch(/^anon-/);
      expect(purgedUser?.email).toBeNull();
      expect(purgedUser?.password_hash).toBeNull();
      expect(purgedUser?.role).toBe('guest');

      // Verificar que sus snapshots no revelados fueron purgados
      const snapshots = await roomRepo.findSnapshotsByMatch(match.id);
      expect(snapshots).toHaveLength(0);

      // Verificar que la partida y el jugador en match_players siguen intactos
      const matchAfter = await roomRepo.findMatchById(match.id);
      expect(matchAfter).not.toBeNull();
      expect(matchAfter?.host_id).toBe(inactiveGuest.id);
      const playerAfter = await roomRepo.findPlayer(match.id, inactiveGuest.id);
      expect(playerAfter).not.toBeNull();

      // Verificar que el guest activo y el usuario registrado siguen intactos
      const activeUserAfter = await userRepo.findById(activeGuest.id);
      expect(activeUserAfter?.gamertag).toBe('guest-active');

      const registeredUserAfter = await userRepo.findById(registeredUser.id);
      expect(registeredUserAfter?.gamertag).toBe('registered-old');
      expect(registeredUserAfter?.email).toBe('user@duelodev.com');

      // Segunda ejecución inmediata: no encuentra nada pendiente
      const secondRun = await service.purgeInactiveGuests(now);
      expect(secondRun.scanned_guests).toBe(0);
      expect(secondRun.purged_guests).toBe(0);
    });

    it('anonymizeGuest anonimiza un invitado bajo demanda y rechaza usuarios no-guest', async () => {
      const userRepo = new InMemoryUserRepository();
      const refreshTokenRepo = new InMemoryRefreshTokenRepository();
      const roomRepo = new InMemoryRoomRepository();

      const service = new RetentionService(userRepo, refreshTokenRepo, roomRepo);

      const guest = await userRepo.create({
        gamertag: 'manual-guest',
        email: 'manual@guest.org',
        role: 'guest',
      });

      const user = await userRepo.create({
        gamertag: 'registered-one',
        email: 'user@example.com',
        role: 'user',
      });

      // Anonimizar usuario regular debe rechazarse (retorna null)
      const userResult = await service.anonymizeGuest(user.id);
      expect(userResult).toBeNull();
      const userCheck = await userRepo.findById(user.id);
      expect(userCheck?.gamertag).toBe('registered-one');

      // Anonimizar guest bajo demanda
      const anonResult = await service.anonymizeGuest(guest.id);
      expect(anonResult).not.toBeNull();
      expect(anonResult?.gamertag).toMatch(/^anon-/);
      expect(anonResult?.email).toBeNull();

      // ID inexistente retorna null
      const nonExistent = await service.anonymizeGuest('non-existent-uuid');
      expect(nonExistent).toBeNull();
    });

    it('soporta configuración por objeto constructor', async () => {
      const userRepo = new InMemoryUserRepository();
      const refreshTokenRepo = new InMemoryRefreshTokenRepository();
      const service = new RetentionService({
        userRepo,
        refreshTokenRepo,
        guestRetentionDays: 15,
        tombstonePrefix: 'exp',
      });

      const guest = await userRepo.create({
        gamertag: 'temp-guest',
        role: 'guest',
      });

      const anon = await service.anonymizeGuest(guest.id);
      expect(anon?.gamertag).toMatch(/^exp-/);
    });

    it('createApp integra correctamente retentionService en ApiContext', () => {
      const app = createApp();
      expect(app.ctx.retentionService).toBeInstanceOf(RetentionService);
    });

    it('programa la purga en el arranque y limpia su timer al cerrar la API', async () => {
      const roomRepo = new InMemoryRoomRepository();
      const match = await roomRepo.createMatch({
        room_code: 'SCHED1',
        mode: 'puntos',
        status: 'finished',
        finished_at: '2026-07-01T12:00:00.000Z',
        config: { max_players: 2, problems_count: 1, round_duration_s: 300 },
        host_id: 'retention-scheduler-user',
      });
      await roomRepo.saveSnapshot({
        match_id: match.id,
        round_id: 'scheduler-round',
        user_id: 'retention-scheduler-user',
        problem_id: 'scheduler-problem',
        language: 'python',
        source_code: 'old private code',
      });
      const app = createApp({ roomRepo, matchCodeRetentionIntervalMs: 60_000 });
      const { port } = await app.start(0, '127.0.0.1');

      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect((await roomRepo.findSnapshotsByMatch(match.id))[0]?.source_code).toBe('');
      } finally {
        await app.close();
      }

      expect(app.server.listening).toBe(false);
      expect(port).toBeGreaterThan(0);
    });
  });

  describe('Matriz de persistencia: purga de guest referenciado y snapshot de jugador sin envíos (doc 06 B04, doc 04 §5)', () => {
    it('purga de guest referenciado y snapshot de jugador sin envíos con is_revealed: true preserva snapshot histórico y anonimiza gamertag en resumen', async () => {
      const app = createApp({
        serviceName: 'api-retention-test',
        authSecret: 'test-retention-secret-duelodev-1234567890',
      });
      const { port } = await app.start(0, '127.0.0.1');
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const now = new Date('2026-09-15T12:00:00.000Z');
        const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 86_400_000).toISOString();

        // 1. Crear host registrado con sesión activa
        const hostAuth = await app.ctx.authService.register({
          email: 'host@duelodev.com',
          password: 'Password123!',
          gamertag: 'host-registered',
        });
        const host = hostAuth.user;

        // Jugador invitado (role: 'guest') con más de 30 días de inactividad
        const guestUser = await app.ctx.userRepo.create({
          gamertag: 'guest-no-subs',
          email: 'guest@ephemeral.local',
          password_hash: 'guest-secret-hash',
          role: 'guest',
          updated_at: thirtyFiveDaysAgo,
        });

        // Token de sesión activo para el invitado (debe revocarse en la purga)
        await app.ctx.refreshTokenRepo.create({
          user_id: guestUser.id,
          token_hash: 'guest-refresh-token-hash',
          family_id: 'guest-family-1',
          expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
        });

        // Crear la partida
        const match = await app.ctx.roomRepo.createMatch({
          room_code: 'PURG01',
          mode: 'puntos',
          config: { max_players: 2, problems_count: 1, round_duration_s: 300 },
          host_id: host.id,
        });

        // 2 y 3. El invitado tiene snapshot de código pero CERO envíos, y tiene is_revealed: true
        await app.ctx.roomRepo.addPlayer({
          match_id: match.id,
          user_id: host.id,
          score: 10,
          cases_total: 5,
          time_total_ms: 30000,
          current_problem_idx: 1,
          is_ready: true,
          is_revealed: true,
        });

        await app.ctx.roomRepo.addPlayer({
          match_id: match.id,
          user_id: guestUser.id,
          score: 0,
          cases_total: 0,
          time_total_ms: 0,
          current_problem_idx: 0,
          is_ready: true,
          is_revealed: true,
        });

        const roundId = randomUUID();
        const problemId = randomUUID();
        const guestDraftCode =
          'def solution():\n    # Código de trabajo sin ningún envío\n    return 42\n';

        await app.ctx.roomRepo.saveSnapshot({
          match_id: match.id,
          round_id: roundId,
          user_id: guestUser.id,
          problem_id: problemId,
          language: 'python',
          source_code: guestDraftCode,
          version: 1,
        });

        // Verificar rigurosamente que el invitado tiene exactamente CERO envíos en submissions
        const guestSubmissions = await app.ctx.submissionRepo.findSubmissionsByUser(
          match.id,
          guestUser.id,
        );
        expect(guestSubmissions).toHaveLength(0);
        const matchSubmissions = await app.ctx.submissionRepo.findSubmissionsByMatch(match.id);
        expect(matchSubmissions.filter((s) => s.user_id === guestUser.id)).toHaveLength(0);

        // Actualizar estado de la partida a finalizada
        const startedAt = new Date(now.getTime() - 3600000).toISOString();
        const finishedAt = new Date(now.getTime() - 1800000).toISOString();
        await app.ctx.roomRepo.updateMatch(match.id, {
          status: 'finished',
          started_at: startedAt,
          finished_at: finishedAt,
          winner_id: host.id,
          winner_ids: [host.id],
          finish_reason: 'target_reached',
        });

        // 4 y 5. Ejecutar la purga habiendo pasado más de 30 días de inactividad
        const purgeResult = await app.ctx.retentionService.purgeInactiveGuests(now);

        expect(purgeResult.scanned_guests).toBe(1);
        expect(purgeResult.purged_guests).toBe(1);
        expect(purgeResult.purged_user_ids).toContain(guestUser.id);
        expect(purgeResult.revoked_sessions).toBe(1);
        // Al tener is_revealed: true, su snapshot no debe ser scrubbed / eliminado
        expect(purgeResult.scrubbed_snapshots).toBe(0);

        // 6. Verificaciones de integridad y anonimización
        // a) El invitado pasa a tener gamertag tombstone (anon-...)
        const purgedGuest = await app.ctx.userRepo.findById(guestUser.id);
        expect(purgedGuest).not.toBeNull();
        expect(purgedGuest?.gamertag).toMatch(/^anon-/);
        expect(isValidGamertag(purgedGuest!.gamertag)).toBe(true);
        expect(purgedGuest?.email).toBeNull();
        expect(purgedGuest?.password_hash).toBeNull();
        expect(purgedGuest?.role).toBe('guest');

        // b) La partida, el jugador en match_players y sus registros referenciados se mantienen intactos
        const matchAfter = await app.ctx.roomRepo.findMatchById(match.id);
        expect(matchAfter).not.toBeNull();
        expect(matchAfter?.id).toBe(match.id);
        expect(matchAfter?.status).toBe('finished');
        expect(matchAfter?.winner_ids).toEqual([host.id]);

        const guestPlayerAfter = await app.ctx.roomRepo.findPlayer(match.id, guestUser.id);
        expect(guestPlayerAfter).not.toBeNull();
        expect(guestPlayerAfter?.user_id).toBe(guestUser.id);
        expect(guestPlayerAfter?.score).toBe(0);
        expect(guestPlayerAfter?.cases_total).toBe(0);
        expect(guestPlayerAfter?.is_revealed).toBe(true);

        const hostPlayerAfter = await app.ctx.roomRepo.findPlayer(match.id, host.id);
        expect(hostPlayerAfter).not.toBeNull();
        expect(hostPlayerAfter?.user_id).toBe(host.id);

        // c) Consulta de resumen vía API REST GET /api/v1/matches/:id/summary (200 OK)
        const restRes = await fetch(`${baseUrl}/api/v1/matches/${match.id}/summary`, {
          headers: {
            Authorization: `Bearer ${hostAuth.accessToken}`,
          },
        });
        expect(restRes.status).toBe(200);
        const summary = (await restRes.json()) as MatchSummaryResponse;

        // Comprobar equivalencia con llamada directa a getMatchSummary
        const directSummary = await app.ctx.roomService.getMatchSummary(match.id, host.id);
        expect(directSummary).toEqual(summary);

        // d) El marcador final_scores incluye al jugador con gamertag tombstone (anon-...), score 0, cases_total 0
        expect(summary.final_scores).toHaveLength(2);
        const guestScoreEntry = summary.final_scores.find((p) => p.user_id === guestUser.id);
        expect(guestScoreEntry).toBeDefined();
        expect(guestScoreEntry?.gamertag).toBe(purgedGuest?.gamertag);
        expect(guestScoreEntry?.gamertag).toMatch(/^anon-/);
        expect(guestScoreEntry?.score).toBe(0);
        expect(guestScoreEntry?.cases_total).toBe(0);
        expect(guestScoreEntry?.time_total_ms).toBe(0);
        expect(guestScoreEntry?.current_problem_idx).toBe(0);

        // e) La lista de snapshots incluye el snapshot revelado del jugador sin envíos con código intacto
        expect(summary.snapshots).toHaveLength(1);
        const snapshotEntry = summary.snapshots.find((s) => s.user_id === guestUser.id);
        expect(snapshotEntry).toBeDefined();
        expect(snapshotEntry?.user_id).toBe(guestUser.id);
        expect(snapshotEntry?.source_code).toBe(guestDraftCode);
        expect(snapshotEntry?.problem_id).toBe(problemId);
        expect(snapshotEntry?.language).toBe('python');
        expect((snapshotEntry as Record<string, unknown>)['email']).toBeUndefined();
        expect((snapshotEntry as Record<string, unknown>)['password_hash']).toBeUndefined();

        // f) No ocurrió ningún error de integridad referencial ni borrado en cascada del historial
        const preservedSnapshots = await app.ctx.roomRepo.findSnapshotsByMatch(match.id);
        expect(preservedSnapshots).toHaveLength(1);
        expect(preservedSnapshots[0]?.user_id).toBe(guestUser.id);

        // Soporte de método HEAD en la ruta de resumen
        const headRes = await fetch(`${baseUrl}/api/v1/matches/${match.id}/summary`, {
          method: 'HEAD',
          headers: {
            Authorization: `Bearer ${hostAuth.accessToken}`,
          },
        });
        expect(headRes.status).toBe(200);

        // Soporte de autenticación mediante cookies
        const cookieRes = await fetch(`${baseUrl}/api/v1/matches/${match.id}/summary`, {
          headers: {
            Cookie: `${AUTH_COOKIE_NAMES.ACCESS_TOKEN}=${hostAuth.accessToken}`,
          },
        });
        expect(cookieRes.status).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('purga de guest referenciado y snapshot de jugador sin envíos con is_revealed: false elimina limpiamente el snapshot del resumen de rivales', async () => {
      const app = createApp({
        serviceName: 'api-retention-test',
        authSecret: 'test-retention-secret-duelodev-1234567890',
      });
      const { port } = await app.start(0, '127.0.0.1');
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const now = new Date('2026-09-15T12:00:00.000Z');
        const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 86_400_000).toISOString();

        // Host registrado
        const hostAuth = await app.ctx.authService.register({
          email: 'host2@duelodev.com',
          password: 'Password123!',
          gamertag: 'host-player-2',
        });
        const host = hostAuth.user;

        // Invitado inactivo (> 30 días)
        const guestUser = await app.ctx.userRepo.create({
          gamertag: 'guest-unrevealed',
          email: 'guest2@ephemeral.local',
          password_hash: 'guest-secret-hash-2',
          role: 'guest',
          updated_at: thirtyFiveDaysAgo,
        });

        // Crear partida finalizada
        const match = await app.ctx.roomRepo.createMatch({
          room_code: 'PURG02',
          mode: 'puntos',
          config: { max_players: 2, problems_count: 1, round_duration_s: 300 },
          host_id: host.id,
        });

        await app.ctx.roomRepo.addPlayer({
          match_id: match.id,
          user_id: host.id,
          score: 5,
          cases_total: 2,
          is_ready: true,
          is_revealed: true,
        });

        // is_revealed: false para el invitado
        await app.ctx.roomRepo.addPlayer({
          match_id: match.id,
          user_id: guestUser.id,
          score: 0,
          cases_total: 0,
          is_ready: true,
          is_revealed: false,
        });

        const roundId = randomUUID();
        const problemId = randomUUID();
        await app.ctx.roomRepo.saveSnapshot({
          match_id: match.id,
          round_id: roundId,
          user_id: guestUser.id,
          problem_id: problemId,
          language: 'cpp',
          source_code: '// Código confidencial no revelado\nint main() { return 0; }',
          version: 1,
        });

        // Cero envíos realizados por el invitado
        const guestSubmissions = await app.ctx.submissionRepo.findSubmissionsByUser(
          match.id,
          guestUser.id,
        );
        expect(guestSubmissions).toHaveLength(0);

        await app.ctx.roomRepo.updateMatch(match.id, {
          status: 'finished',
          started_at: new Date(now.getTime() - 3600000).toISOString(),
          finished_at: new Date(now.getTime() - 1800000).toISOString(),
          winner_id: host.id,
          winner_ids: [host.id],
          finish_reason: 'target_reached',
        });

        // Ejecutar purga de invitados inactivos
        const purgeResult = await app.ctx.retentionService.purgeInactiveGuests(now);

        expect(purgeResult.scanned_guests).toBe(1);
        expect(purgeResult.purged_guests).toBe(1);
        expect(purgeResult.purged_user_ids).toContain(guestUser.id);
        // Snapshot no revelado DEBE ser eliminado (scrubbed)
        expect(purgeResult.scrubbed_snapshots).toBe(1);

        // Comprobar que en el repositorio el snapshot del invitado fue completamente eliminado
        const snapshotsInRepo = await app.ctx.roomRepo.findSnapshotsByMatch(match.id);
        expect(snapshotsInRepo.filter((s) => s.user_id === guestUser.id)).toHaveLength(0);

        // Gamertag tombstone aplicado
        const purgedGuest = await app.ctx.userRepo.findById(guestUser.id);
        expect(purgedGuest?.gamertag).toMatch(/^anon-/);
        expect(purgedGuest?.email).toBeNull();
        expect(purgedGuest?.password_hash).toBeNull();

        // Consulta de resumen por parte del rival (host)
        const restRes = await fetch(`${baseUrl}/api/v1/matches/${match.id}/summary`, {
          headers: {
            Authorization: `Bearer ${hostAuth.accessToken}`,
          },
        });
        expect(restRes.status).toBe(200);
        const summary = (await restRes.json()) as MatchSummaryResponse;

        // El marcador sigue incluyendo al jugador con tombstone y score 0
        expect(summary.final_scores).toHaveLength(2);
        const guestScoreEntry = summary.final_scores.find((p) => p.user_id === guestUser.id);
        expect(guestScoreEntry?.gamertag).toBe(purgedGuest?.gamertag);
        expect(guestScoreEntry?.score).toBe(0);

        // El snapshot no revelado fue eliminado limpiamente y no aparece en el resumen
        expect(summary.snapshots).toHaveLength(0);

        // Comprobar con la llamada de servicio directo
        const directSummary = await app.ctx.roomService.getMatchSummary(match.id, host.id);
        expect(directSummary.snapshots).toHaveLength(0);

        // Partida y jugador siguen intactos
        const matchAfter = await app.ctx.roomRepo.findMatchById(match.id);
        expect(matchAfter).not.toBeNull();
        expect(matchAfter?.status).toBe('finished');
        const playerAfter = await app.ctx.roomRepo.findPlayer(match.id, guestUser.id);
        expect(playerAfter).not.toBeNull();
      } finally {
        await app.close();
      }
    });
  });
});
