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
import { createProductionRealtimeServer, type RealtimeServer } from '../../realtime/src/index.js';
import { runMigrations, rollbackMigrations } from '../src/services/migrations.js';
import { seedProblems } from '../src/seeds/seeder.js';
import {
  PostgresProblemRepository,
  PostgresSubmissionRepository,
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

describe('Integración Durable: API → Redis Stream → Juez → PostgreSQL → Pub/Sub → Realtime', () => {
  let pool: pg.Pool;
  let redis: Redis;
  let isInfrastructureAvailable = false;

  let apiApp: (ApiApp & { pool: pg.Pool; redis: Redis }) | null = null;
  let realtimeServer: (RealtimeServer & { pool: pg.Pool; redis: Redis }) | null = null;
  let apiBaseUrl: string;

  beforeAll(async () => {
    // Verificar si la infraestructura de prueba está accesible
    try {
      pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      await pool.query('SELECT 1');

      redis = new Redis(TEST_REDIS_URL, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
      await redis.connect();
      await redis.ping();

      isInfrastructureAvailable = true;
    } catch {
      console.warn(
        'Infraestructura de prueba (PostgreSQL o Redis) no disponible. Saltando pruebas de integración.',
      );
      isInfrastructureAvailable = false;
      return;
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
    if (!isInfrastructureAvailable) return;

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
    if (!isInfrastructureAvailable) return;

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

  it('2. Flujo completo: registro, creación de sala, admisión y encolado en Redis Streams', async () => {
    if (!isInfrastructureAvailable) return;

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
      categories: ['muy_facil'],
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

    // E. Usuario A inicia la sala
    const resStart = await fetch(`${apiBaseUrl}/api/v1/rooms/${roomCode}/start`, {
      method: 'POST',
      headers: {
        cookie: cookieA,
      },
    });
    expect(resStart.status).toBe(200);

    // F. Obtener problema público para enviar
    const probRepo = new PostgresProblemRepository(pool);
    const problems = await probRepo.findAllProblems();
    const problem = problems[0]!;

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
        problem_id: problem.id,
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
    expect(fieldsMap.get('problem_id')).toBe(problem.id);
    expect(fieldsMap.get('problem_version')).toBe(String(problem.version));
    expect(fieldsMap.get('language')).toBe('python');
    expect(fieldsMap.get('cases_ref')).toBe(`cases/${problem.id}`);
    expect(fieldsMap.get('time_limit_ms')).toBe(
      String(resolveTimeLimitMs(problem.time_limit_ms, 'python')),
    );
  });

  it('3. Persistencia durable S19, notificación Pub/Sub, consumo e idempotencia en Realtime', async () => {
    if (!isInfrastructureAvailable) return;

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
    if (!isInfrastructureAvailable) return;

    // Obtener un match existente
    const matchRes = await pool.query("SELECT id FROM matches WHERE status = 'running' LIMIT 1");
    if (matchRes.rows.length === 0) return;
    const matchId = matchRes.rows[0].id;

    const probRepo = new PostgresProblemRepository(pool);
    const problems = await probRepo.findAllProblems();
    const problem = problems[0]!;

    const subRepo = new PostgresSubmissionRepository(pool);

    // Ejecutar 3 creaciones concurrentes directas al repositorio PostgreSQL
    const promises = [1, 2, 3].map((i) =>
      subRepo.createSubmission({
        match_id: matchId,
        round_id: matchId,
        user_id: '00000000-0000-0000-0000-000000000001',
        problem_id: problem.id,
        language: 'python',
        source_code: `print(${i})`,
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        status: 'queued',
      }),
    );

    const results = await Promise.all(promises);
    const seqs = results.map((r) => r.admission_seq);

    // Deben ser todos distintos y mayores que 1
    expect(new Set(seqs).size).toBe(3);
    for (const seq of seqs) {
      expect(seq).toBeGreaterThan(1);
    }
  });

  it('5. Reconciliación de estado: recuperación determinista ante avisos perdidos', async () => {
    if (!isInfrastructureAvailable) return;

    const matchRes = await pool.query("SELECT id FROM matches WHERE status = 'running' LIMIT 1");
    if (matchRes.rows.length === 0) return;
    const matchId = matchRes.rows[0].id;

    const probRepo = new PostgresProblemRepository(pool);
    const problems = await probRepo.findAllProblems();
    const problem = problems[0]!;

    const subRepo = new PostgresSubmissionRepository(pool);

    // Crear un envío completado en la BD que nunca recibió aviso Pub/Sub
    const orphanedSub = await subRepo.createSubmission({
      match_id: matchId,
      round_id: matchId,
      user_id: '00000000-0000-0000-0000-000000000002',
      problem_id: problem.id,
      language: 'python',
      source_code: 'print("reconciled")',
      time_limit_ms: 2000,
      memory_limit_mb: 256,
      status: 'completed',
      verdict: 'AC',
      passed_cases: 10,
      total_cases: 10,
      exec_time_ms: 50,
      judged_at: new Date().toISOString(),
    });

    // Ejecutar reconciliación de Realtime sobre la partida
    if (realtimeServer?.stateReconciler) {
      const count = await realtimeServer.stateReconciler.reconcileMatch(matchId);
      expect(count).toBeGreaterThanOrEqual(1);

      // Verificar que quedó registrado en match_processed_submissions
      const checkRes = await pool.query(
        'SELECT 1 FROM match_processed_submissions WHERE submission_id = $1',
        [orphanedSub.id],
      );
      expect(checkRes.rows.length).toBe(1);
    }
  });
});
