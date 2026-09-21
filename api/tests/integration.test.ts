import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
const { Pool } = pg;
import { Redis } from 'ioredis';
import {
  JUDGE_RESULTS_CHANNEL,
  JUDGE_STREAM_KEY,
  resolveTimeLimitMs,
  type JudgeResultNotification,
  type MatchConfig,
  type RoomCreatedResponse,
  type SubmissionAcceptedResponse,
} from '@duelodev/shared';
import { createProductionApp, type ApiApp } from '../src/index.js';
import {
  createProductionRealtimeServer,
  PostgresYjsSnapshotStore,
  type RealtimeServer,
} from '../../realtime/src/index.js';
import type { CodeSnapshot, YjsClientConnection } from '../../realtime/src/yjs/types.js';
import { sharedRoundId } from '../../realtime/src/gamemodes/round-id.js';
import { runMigrations, rollbackMigrations } from '../src/services/migrations.js';
import { seedProblems } from '../src/seeds/seeder.js';
import {
  PostgresProblemRepository,
  PostgresRoomRepository,
  PostgresSubmissionRepository,
  PostgresUserRepository,
} from '../src/repositories/postgres.js';

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://duelodev:test@127.0.0.1:55432/duelodev_test';
const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:56379';
const TEST_AUTH_SECRET = 'test-integration-auth-secret-32-characters-min!';

function extractCookieHeader(res: Response): string {
  const rawCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];

  const cookies: string[] = [];
  for (const str of rawCookies) {
    if (!str) continue;
    const firstPart = str.split(';')[0];
    if (firstPart) {
      cookies.push(firstPart.trim());
    }
  }
  return cookies.join('; ');
}

interface RunningMatchFixture {
  matchId: string;
  userId: string;
}

async function createRunningMatchFixture(
  pool: pg.Pool,
  label: string,
): Promise<RunningMatchFixture> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const userRepo = new PostgresUserRepository(pool);
  const roomRepo = new PostgresRoomRepository(pool);

  const user = await userRepo.create({
    email: `${label}.${suffix}@duelodev.test`,
    password_hash: 'integration-fixture-not-a-real-password',
    gamertag: `${label}-${suffix}`,
    role: 'user',
  });

  const config: MatchConfig = {
    mode: 'puntos',
    num_problems: 3,
    time_per_problem_s: 60,
    categories: ['facil'],
    max_players: 2,
  };

  const match = await roomRepo.createMatch({
    room_code: `${label[0] ?? 'I'}${suffix}`.toUpperCase(),
    mode: 'puntos',
    status: 'running',
    config,
    host_id: user.id,
    started_at: new Date().toISOString(),
  });

  await roomRepo.addPlayer({
    match_id: match.id,
    user_id: user.id,
    is_ready: true,
    connection_status: 'connected',
  });

  return {
    matchId: match.id,
    userId: user.id,
  };
}

describe('Integración Durable: API → Redis Stream → Juez → PostgreSQL → Pub/Sub → Realtime', () => {
  let pool: pg.Pool;
  let redis: Redis;

  let apiApp: (ApiApp & { pool: pg.Pool; redis: Redis }) | null = null;
  let realtimeServer: (RealtimeServer & { pool: pg.Pool; redis: Redis }) | null = null;
  let apiBaseUrl: string;

  beforeAll(async () => {
    // La integración es un gate estricto: infraestructura ausente debe fallar,
    // nunca convertir cinco pruebas sin aserciones en un resultado verde.
    const candidatePool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
    let candidateRedis: Redis | undefined;

    try {
      await candidatePool.query('SELECT 1');

      candidateRedis = new Redis(TEST_REDIS_URL, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
      await candidateRedis.connect();
      await candidateRedis.ping();

      pool = candidatePool;
      redis = candidateRedis;
    } catch (error) {
      candidateRedis?.disconnect();
      await candidatePool.end().catch(() => {});

      throw new Error(
        `Infraestructura de integración no disponible. PostgreSQL: ${TEST_DATABASE_URL}; Redis: ${TEST_REDIS_URL}`,
        { cause: error },
      );
    }

    // 1. Limpieza inicial y migraciones
    await rollbackMigrations(pool).catch(() => {});
    await runMigrations(pool);
    await redis.flushall();

    // 2. Inicializar y arrancar servidor API real conectado a Postgres y Redis
    apiApp = await createProductionApp({
      databaseUrl: TEST_DATABASE_URL,
      redisUrl: TEST_REDIS_URL,
      authSecret: TEST_AUTH_SECRET,
      seedPilotProblems: true,
      roomInstructionsDurationMs: 0,
    });

    const { port: apiPort } = await apiApp.start(0, '127.0.0.1');
    apiBaseUrl = `http://127.0.0.1:${apiPort}`;

    // 3. Inicializar y arrancar servidor Realtime conectado a Postgres y Redis
    realtimeServer = await createProductionRealtimeServer({
      databaseUrl: TEST_DATABASE_URL,
      redisUrl: TEST_REDIS_URL,
      authSecret: TEST_AUTH_SECRET,
      reconnectGraceMs: 2000,
    });
    await realtimeServer.start(0, '127.0.0.1');
  });

  afterAll(async () => {
    if (apiApp) {
      await apiApp.close();
    }
    if (realtimeServer) {
      await realtimeServer.close();
    }
    if (redis) {
      await redis.quit();
    }
    if (pool) {
      await pool.end();
    }
  });

  it('1. Migraciones DDL e idempotencia de reversión/reinicio', async () => {
    // Ejecutar rollback completo para probar idempotencia
    await rollbackMigrations(pool);

    // Ejecutar migración UP desde cero
    await runMigrations(pool);

    // Sembrar problemas piloto para las pruebas
    const probRepo = new PostgresProblemRepository(pool);
    await seedProblems(probRepo);

    const problems = await probRepo.findAllProblems();
    expect(problems.length).toBeGreaterThanOrEqual(1);
  });

  it('vacía snapshots vencidos en PostgreSQL sin borrar partidas ni jugadores', async () => {
    const roomRepo = new PostgresRoomRepository(pool);
    const problemRepo = new PostgresProblemRepository(pool);
    const problem = (await problemRepo.findAllProblems())[0];
    expect(problem).toBeDefined();

    const expired = await createRunningMatchFixture(pool, 'retold');
    await roomRepo.updateMatch(expired.matchId, {
      status: 'finished',
      finished_at: '2026-08-01T12:00:00.000Z',
    });
    const expiredSnapshot = await roomRepo.saveSnapshot({
      match_id: expired.matchId,
      round_id: expired.matchId,
      user_id: expired.userId,
      problem_id: problem!.id,
      language: 'python',
      source_code: 'historical private code',
    });

    const recent = await createRunningMatchFixture(pool, 'retnew');
    await roomRepo.updateMatch(recent.matchId, {
      status: 'finished',
      finished_at: '2026-09-01T12:00:00.000Z',
    });
    await roomRepo.saveSnapshot({
      match_id: recent.matchId,
      round_id: recent.matchId,
      user_id: recent.userId,
      problem_id: problem!.id,
      language: 'python',
      source_code: 'recent private code',
    });

    const scrubbed = await roomRepo.scrubExpiredCodeSnapshots('2026-08-31T12:00:00.000Z');

    expect(scrubbed).toBe(1);
    expect(await roomRepo.findMatchById(expired.matchId)).not.toBeNull();
    expect(await roomRepo.findPlayer(expired.matchId, expired.userId)).not.toBeNull();
    expect(await roomRepo.findSnapshotsByMatch(expired.matchId)).toMatchObject([
      { id: expiredSnapshot.id, source_code: '' },
    ]);
    expect((await roomRepo.findSnapshotsByMatch(recent.matchId))[0]?.source_code).toBe(
      'recent private code',
    );
  });

  it('persiste snapshots Yjs consentidos, valida membresía y tolera reintentos sin duplicar', async () => {
    const fixture = await createRunningMatchFixture(pool, 'yjsnap');
    const problemRepo = new PostgresProblemRepository(pool);
    const problem = (await problemRepo.findAllProblems())[0];
    expect(problem).toBeDefined();

    const snapshot: CodeSnapshot = {
      id: randomUUID(),
      matchId: fixture.matchId,
      roundId: randomUUID(),
      userId: fixture.userId,
      problemId: problem!.id,
      generation: 2,
      code: 'print("snapshot integrado")',
      capturedAt: new Date().toISOString(),
      isRevealed: true,
    };
    const store = new PostgresYjsSnapshotStore(pool);

    await store.persist(snapshot);
    await store.persist(snapshot);

    const stored = await pool.query(
      'SELECT source_code, is_revealed, version FROM match_code_snapshots WHERE id = $1',
      [snapshot.id],
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]).toMatchObject({
      source_code: snapshot.code,
      is_revealed: true,
      version: snapshot.generation,
    });

    const outsiderSnapshot = { ...snapshot, id: randomUUID(), userId: randomUUID() };
    await store.persist(outsiderSnapshot);
    const outsider = await pool.query('SELECT id FROM match_code_snapshots WHERE id = $1', [
      outsiderSnapshot.id,
    ]);
    expect(outsider.rowCount).toBe(0);
  });

  it('el Realtime de producción congela y persiste Yjs al cerrar una partida', async () => {
    const fixture = await createRunningMatchFixture(pool, 'yjsprod');
    const roomRepo = new PostgresRoomRepository(pool);
    const problemRepo = new PostgresProblemRepository(pool);
    const problem = (await problemRepo.findAllProblems())[0];
    expect(problem).toBeDefined();
    await roomRepo.updateMatch(fixture.matchId, { status: 'lobby' });

    const durableRealtime = realtimeServer!;
    await durableRealtime.matchHub.startMatch(fixture.matchId, [problem!.id]);
    const session = await durableRealtime.ctx.matchStore.getMatch(fixture.matchId);
    expect(session?.status).toBe('running');
    session!.players.get(fixture.userId)!.is_revealed = true;
    await durableRealtime.ctx.matchStore.saveMatch(session!);

    const connection: YjsClientConnection = {
      id: 'integration-yjs-owner',
      userId: fixture.userId,
      matchId: fixture.matchId,
      targetUserId: fixture.userId,
      isOwner: true,
      send: () => undefined,
      sendText: () => undefined,
      close: () => undefined,
    };
    const result = await durableRealtime.yjsHub.handleConnection(
      `/yjs/${fixture.matchId}/${fixture.userId}`,
      connection,
      { userId: fixture.userId, gamertag: 'yjs-prod', role: 'user' },
    );
    expect(result.authorized).toBe(true);
    expect(
      await durableRealtime.yjsHub.handleIncomingTextUpdate(
        connection,
        'print("production lifecycle")',
        result.document!.generation,
      ),
    ).toMatchObject({ applied: true });

    await durableRealtime.matchHub.closeMatchFromAdmin(fixture.matchId, 2);

    const rows = await pool.query(
      `SELECT round_id, problem_id, source_code, is_revealed
       FROM match_code_snapshots WHERE match_id = $1 AND user_id = $2`,
      [fixture.matchId, fixture.userId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      round_id: sharedRoundId(fixture.matchId, 0),
      problem_id: problem!.id,
      source_code: 'print("production lifecycle")',
      is_revealed: true,
    });
    expect(durableRealtime.yjsHub.getDocument(fixture.matchId, fixture.userId)?.isFrozen).toBe(
      true,
    );
  });

  it('2. Flujo completo: registro, creación de sala, admisión y encolado en Redis Streams', async () => {
    // A. Registrar Usuario A (Host)
    const resRegA = await fetch(`${apiBaseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'jugador.a@duelodev.test',
        password: 'Password123!',
        gamertag: 'jugador-a',
      }),
    });
    expect(resRegA.status).toBe(201);
    const cookieA = extractCookieHeader(resRegA);

    // B. Registrar Usuario B
    const resRegB = await fetch(`${apiBaseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'jugador.b@duelodev.test',
        password: 'Password123!',
        gamertag: 'jugador-b',
      }),
    });
    expect(resRegB.status).toBe(201);
    const cookieB = extractCookieHeader(resRegB);

    // C. Usuario A crea una sala en modo puntos
    const roomConfig: MatchConfig = {
      mode: 'puntos',
      num_problems: 3,
      time_per_problem_s: 60,
      categories: ['facil'],
      max_players: 2,
    };
    const resCreateRoom = await fetch(`${apiBaseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieA,
      },
      body: JSON.stringify({
        config: roomConfig,
      }),
    });
    expect(resCreateRoom.status).toBe(201);
    const roomData = (await resCreateRoom.json()) as RoomCreatedResponse;
    const matchId = roomData.match_id;
    const roomCode = roomData.room_code;

    // D. Usuario B se une a la sala
    const resJoin = await fetch(`${apiBaseUrl}/api/v1/rooms/${roomCode}/join`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieB,
      },
      body: JSON.stringify({ gamertag: 'jugador-b' }),
    });
    expect(resJoin.status).toBe(200);

    const lobbySession = await realtimeServer!.ctx.matchStore.getMatch(matchId);
    expect(lobbySession?.status).toBe('lobby');
    expect(lobbySession?.problem_ids).toBeUndefined();

    // E. Usuario A inicia la sala
    const resStart = await fetch(`${apiBaseUrl}/api/v1/rooms/${roomCode}/start`, {
      method: 'POST',
      headers: {
        cookie: cookieA,
      },
    });
    expect(resStart.status).toBe(200);

    const runningSession = await realtimeServer!.ctx.matchStore.getMatch(matchId);
    expect(runningSession?.status).toBe('running');
    expect(runningSession?.current_round_id).toBe(matchId);
    expect(runningSession?.problem_ids).toHaveLength(roomConfig.num_problems);
    expect(runningSession?.round_ends_at).toBeGreaterThan(Date.now());

    // F. Obtener el problema activo según Realtime para enviar
    const probRepo = new PostgresProblemRepository(pool);
    const problems = await probRepo.findAllProblems();
    const problem = problems.find((candidate) => candidate.id === runningSession?.problem_ids?.[0]);
    expect(problem).toBeDefined();

    // G. Usuario A envía una solución (POST /api/v1/submissions)
    const roundId = matchId;
    const resSubmit = await fetch(`${apiBaseUrl}/api/v1/submissions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieA,
      },
      body: JSON.stringify({
        match_id: matchId,
        round_id: roundId,
        problem_id: problem!.id,
        language: 'python',
        source_code: 'import sys\nprint(42)',
      }),
    });
    expect(resSubmit.status).toBe(202);
    const subAccepted = (await resSubmit.json()) as SubmissionAcceptedResponse;
    expect(subAccepted.status).toBe('queued');
    expect(subAccepted.admission_seq).toBe(1);

    // H. Verificar que el trabajo fue encolado en Redis Streams (judge:stream)
    const streamEntries = await redis.xread('COUNT', 1, 'STREAMS', JUDGE_STREAM_KEY, '0-0');
    expect(streamEntries).not.toBeNull();
    const [streamName, entries] = streamEntries![0]!;
    expect(streamName).toBe(JUDGE_STREAM_KEY);
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const firstEntry = entries[0]!;
    const fields = firstEntry[1];
    const fieldsMap = new Map<string, string>();
    for (let i = 0; i < fields.length; i += 2) {
      fieldsMap.set(fields[i]!, fields[i + 1]!);
    }

    expect(fieldsMap.get('schema_version')).toBe('1');
    expect(fieldsMap.get('submission_id')).toBe(subAccepted.submission_id);
    expect(fieldsMap.get('problem_id')).toBe(problem!.id);
    expect(fieldsMap.get('problem_version')).toBe(String(problem!.version));
    expect(fieldsMap.get('language')).toBe('python');
    expect(fieldsMap.get('cases_ref')).toBe(`cases/${problem!.id}`);
    expect(fieldsMap.get('time_limit_ms')).toBe(
      String(resolveTimeLimitMs(problem!.time_limit_ms, 'python')),
    );
  });

  it('3. Persistencia durable S19, notificación Pub/Sub, consumo e idempotencia en Realtime', async () => {
    const subRepo = new PostgresSubmissionRepository(pool);
    const pending = await subRepo.findPendingSubmissions(1);
    expect(pending.length).toBe(1);
    const sub = pending[0]!;

    // Simulación del Worker: Reclamar lease S19
    const claimRes = await subRepo.claimSubmission(sub.id, 'worker-integration-1', 60000);
    expect(claimRes.status).toBe('acquired');
    expect(claimRes.attempt_token).toBeDefined();

    // Simulación del Worker: Persistir veredicto AC
    const persistRes = await subRepo.persistIfCurrent(
      {
        submission_id: sub.id,
        verdict: 'AC',
        passed_cases: 12,
        total_cases: 12,
        exec_time_ms: 25,
        compile_output: null,
        judge_error: null,
      },
      claimRes.attempt_token!,
    );
    expect(persistRes).toBe('stored');

    // Verificar en BD que el veredicto es AC y lease fue limpiado
    const updatedSub = await subRepo.findSubmissionById(sub.id);
    expect(updatedSub?.status).toBe('completed');
    expect(updatedSub?.verdict).toBe('AC');

    // Simulación del Worker: Publicar aviso en judge:results
    const notification: JudgeResultNotification = {
      submission_id: sub.id,
      match_id: sub.match_id,
      round_id: sub.round_id,
      user_id: sub.user_id,
      verdict: 'AC',
      passed: 12,
      total: 12,
      exec_time_ms: 25,
    };

    await redis.publish(JUDGE_RESULTS_CHANNEL, JSON.stringify(notification));

    // Esperar a que Realtime JudgeResultsConsumer procese el aviso
    let processed = false;
    for (let i = 0; i < 20; i++) {
      const checkRes = await pool.query(
        'SELECT 1 FROM match_processed_submissions WHERE submission_id = $1',
        [sub.id],
      );
      if (checkRes.rows.length > 0) {
        processed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(processed).toBe(true);

    // Idempotencia: el segundo aviso idéntico es descartado sin doble cómputo
    await redis.publish(JUDGE_RESULTS_CHANNEL, JSON.stringify(notification));
    await new Promise((r) => setTimeout(r, 200));

    const countRes = await pool.query(
      'SELECT COUNT(*)::int as count FROM match_processed_submissions WHERE submission_id = $1',
      [sub.id],
    );
    expect(countRes.rows[0].count).toBe(1);
  });

  it('4. Concurrencia de admisión: asignación atómica y monotónica de admission_seq', async () => {
    const fixture = await createRunningMatchFixture(pool, 'conc');
    const probRepo = new PostgresProblemRepository(pool);
    const problems = await probRepo.findAllProblems();
    expect(problems.length).toBeGreaterThan(0);
    const problem = problems[0]!;

    const subRepo = new PostgresSubmissionRepository(pool);

    // Cada transacción solicita asignación automática con admission_seq = 0.
    // El UPDATE atómico de matches debe serializar los tres incrementos.
    const results = await Promise.all(
      [1, 2, 3].map((i) =>
        subRepo.createSubmission({
          match_id: fixture.matchId,
          round_id: fixture.matchId,
          user_id: fixture.userId,
          problem_id: problem.id,
          language: 'python',
          source_code: `print(${i})`,
          time_limit_ms: 2000,
          memory_limit_mb: 256,
          admission_seq: 0,
          status: 'queued',
        }),
      ),
    );

    const seqs = results.map((result) => result.admission_seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3]);

    const matchSeq = await pool.query('SELECT admission_seq FROM matches WHERE id = $1', [
      fixture.matchId,
    ]);
    expect(Number(matchSeq.rows[0]?.admission_seq)).toBe(3);
  });

  it('5. Una salida concurrente gana la carrera antes de admitir y persistir un envío', async () => {
    const fixture = await createRunningMatchFixture(pool, 'left');
    const problemRepo = new PostgresProblemRepository(pool);
    const problems = await problemRepo.findAllProblems();
    expect(problems.length).toBeGreaterThan(0);

    const leaveClient = await pool.connect();
    try {
      await leaveClient.query('BEGIN');
      await leaveClient.query(
        'UPDATE matches SET state_version = state_version + 1 WHERE id = $1',
        [fixture.matchId],
      );
      await leaveClient.query(
        `UPDATE match_players
         SET connection_status = 'left', left_at = clock_timestamp()
         WHERE match_id = $1 AND user_id = $2`,
        [fixture.matchId, fixture.userId],
      );

      const repository = new PostgresSubmissionRepository(pool);
      const pendingSubmission = repository.createSubmissionForActivePlayer({
        match_id: fixture.matchId,
        round_id: fixture.matchId,
        user_id: fixture.userId,
        problem_id: problems[0]!.id,
        language: 'python',
        source_code: 'print("must not be admitted")',
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        admission_seq: 0,
        status: 'queued',
      });
      const didWaitForLeave = await Promise.race([
        pendingSubmission.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 25)),
      ]);

      await leaveClient.query('COMMIT');
      const submission = await pendingSubmission;

      expect(didWaitForLeave).toBe(true);
      expect(submission).toBeNull();
      const storedSubmissions = await pool.query(
        'SELECT id FROM submissions WHERE match_id = $1 AND user_id = $2',
        [fixture.matchId, fixture.userId],
      );
      expect(storedSubmissions.rows).toHaveLength(0);
      const match = await pool.query('SELECT admission_seq FROM matches WHERE id = $1', [
        fixture.matchId,
      ]);
      expect(Number(match.rows[0]?.admission_seq)).toBe(0);
    } finally {
      await leaveClient.query('ROLLBACK').catch(() => undefined);
      leaveClient.release();
    }
  });

  it('6. Reconciliación de estado: recuperación determinista ante avisos perdidos', async () => {
    const fixture = await createRunningMatchFixture(pool, 'recon');
    const probRepo = new PostgresProblemRepository(pool);
    const problems = await probRepo.findAllProblems();
    expect(problems.length).toBeGreaterThan(0);
    const problem = problems[0]!;

    const subRepo = new PostgresSubmissionRepository(pool);

    // WA ejercita una transición observable de puntuación sin finalizar la
    // partida, aislando esta prueba del flujo AC cubierto en el caso anterior.
    const orphanedSub = await subRepo.createSubmission({
      match_id: fixture.matchId,
      round_id: fixture.matchId,
      user_id: fixture.userId,
      problem_id: problem.id,
      language: 'python',
      source_code: 'print("reconciled")',
      time_limit_ms: 2000,
      memory_limit_mb: 256,
      admission_seq: 0,
      status: 'completed',
      verdict: 'WA',
      passed_cases: 3,
      total_cases: 10,
      exec_time_ms: 50,
      judged_at: new Date().toISOString(),
    });

    expect(realtimeServer?.stateReconciler).toBeDefined();
    const count = await realtimeServer!.stateReconciler!.reconcileMatch(fixture.matchId);
    expect(count).toBe(1);

    const processed = await pool.query(
      'SELECT 1 FROM match_processed_submissions WHERE submission_id = $1',
      [orphanedSub.id],
    );
    expect(processed.rows.length).toBe(1);

    const durableState = await pool.query(
      `SELECT m.status, mp.cases_total
       FROM matches m
       JOIN match_players mp ON mp.match_id = m.id
       WHERE m.id = $1 AND mp.user_id = $2`,
      [fixture.matchId, fixture.userId],
    );
    expect(durableState.rows).toHaveLength(1);
    expect(durableState.rows[0]?.status).toBe('running');
    expect(Number(durableState.rows[0]?.cases_total)).toBe(3);

    // Una segunda pasada no puede aplicar el mismo envío otra vez.
    const duplicateCount = await realtimeServer!.stateReconciler!.reconcileMatch(fixture.matchId);
    expect(duplicateCount).toBe(0);

    const stateAfterDuplicate = await pool.query(
      'SELECT cases_total FROM match_players WHERE match_id = $1 AND user_id = $2',
      [fixture.matchId, fixture.userId],
    );
    expect(Number(stateAfterDuplicate.rows[0]?.cases_total)).toBe(3);
  });
});
