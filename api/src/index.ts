import { fileURLToPath } from 'node:url';
import pg from 'pg';
const { Pool } = pg;
import type { Pool as PgPool } from 'pg';
import { Redis } from 'ioredis';
import { createApp, type ApiApp } from './app.js';
import {
  PostgresEventRepository,
  PostgresProblemRepository,
  PostgresRefreshTokenRepository,
  PostgresRoomRepository,
  PostgresRoomCreationPolicyRepository,
  PostgresSubmissionRepository,
  PostgresUserRepository,
} from './repositories/postgres.js';
import { RedisJudgeQueue, RedisResultPublisher } from './queue/redis.js';
import { RedisMatchControlPublisher } from './queue/control.js';
import { parseCorsOrigins } from './plugins/cors.js';
import { runMigrations } from './services/migrations.js';
import { ensureConfiguredAdmin } from './services/admin.js';
import { MATCH_INSTRUCTIONS_DURATION_MS } from '@duelodev/shared';

export * from './types.js';
export * from './schemas/index.js';
export * from './plugins/index.js';
export * from './services/index.js';
export * from './repositories/index.js';
export * from './queue/index.js';
export * from './seeds/index.js';
export * from './infrastructure/index.js';
export * from './routes/health.js';
export * from './routes/auth.js';
export * from './routes/rooms.js';
export * from './routes/submissions.js';
export * from './routes/matches.js';
export * from './routes/admin.js';
export * from './routes/router.js';
export { createApp, type ApiApp };

export interface ProductionApiAppConfig {
  databaseUrl: string;
  redisUrl: string;
  authSecret: string;
  seedPilotProblems?: boolean;
  runMigrations?: boolean;
  corsOrigins?: string[];
  roomInstructionsDurationMs?: number;
}

/**
 * Crea la aplicación API configurada con adaptadores reales de producción
 * (PostgreSQL, Redis Streams, Redis Pub/Sub). Exige URLs válidas y activas.
 */
export async function createProductionApp(
  config: ProductionApiAppConfig,
): Promise<ApiApp & { pool: PgPool; redis: Redis }> {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL es obligatoria para la ejecución de producción');
  }
  if (!config.redisUrl) {
    throw new Error('REDIS_URL es obligatoria para la ejecución de producción');
  }
  if (!config.authSecret) {
    throw new Error('AUTH_SECRET es obligatorio para la ejecución de producción');
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  await pool.query('SELECT 1');
  if (config.runMigrations ?? true) {
    await runMigrations(pool);
  }

  const redis = new Redis(config.redisUrl);
  await redis.ping();

  const userRepo = new PostgresUserRepository(pool);
  const refreshTokenRepo = new PostgresRefreshTokenRepository(pool);
  const roomRepo = new PostgresRoomRepository(pool);
  const roomCreationPolicyRepo = new PostgresRoomCreationPolicyRepository(pool);
  const problemRepo = new PostgresProblemRepository(pool);
  const submissionRepo = new PostgresSubmissionRepository(pool);
  const eventRepo = new PostgresEventRepository(pool);

  const judgeQueue = new RedisJudgeQueue({ redis });
  const resultPublisher = new RedisResultPublisher({ redis });
  const matchControlPublisher = new RedisMatchControlPublisher({ redis });

  const databasePing = async (): Promise<void> => {
    await pool.query('SELECT 1');
  };
  const redisPing = async (): Promise<void> => {
    await redis.ping();
  };

  const app = createApp({
    userRepo,
    refreshTokenRepo,
    roomRepo,
    roomCreationPolicyRepo,
    validateRoomProblemAvailability: true,
    roomInstructionsDurationMs: config.roomInstructionsDurationMs ?? MATCH_INSTRUCTIONS_DURATION_MS,
    problemRepo,
    submissionRepo,
    eventRepo,
    judgeQueue,
    resultPublisher,
    matchControlPublisher,
    authSecret: config.authSecret,
    databasePing,
    redisPing,
    seedPilotProblems: config.seedPilotProblems ?? false,
    ephemeralGuestSessions: process.env['EPHEMERAL_GUEST_SESSIONS'] === '1',
    corsOptions: {
      allowedOrigins: config.corsOrigins ?? [],
      allowCredentials: true,
    },
    csrfOptions: {
      allowedOrigins: config.corsOrigins ?? [],
    },
  });

  const adminPassword = process.env['ADMIN_PASSWORD'];
  if (adminPassword) {
    await ensureConfiguredAdmin(userRepo, adminPassword);
  }

  const originalClose = app.close.bind(app);
  const extendedClose = async (): Promise<void> => {
    await originalClose();
    await judgeQueue.close();
    await resultPublisher.close();
  };

  return Object.assign(app, {
    pool,
    redis,
    close: extendedClose,
  });
}

// Inicio autónomo cuando se ejecuta directamente el archivo
const isDirectExecution =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  const databaseUrl = process.env['DATABASE_URL'];
  const redisUrl = process.env['REDIS_URL'];
  const authSecret = process.env['AUTH_SECRET'];

  if (!databaseUrl || !redisUrl || !authSecret) {
    const missing: string[] = [];
    if (!databaseUrl) missing.push('DATABASE_URL');
    if (!redisUrl) missing.push('REDIS_URL');
    if (!authSecret) missing.push('AUTH_SECRET');
    console.error(
      JSON.stringify({
        level: 'error',
        message: `Faltan variables de entorno requeridas para producción: ${missing.join(', ')}`,
      }),
    );
    process.exit(1);
  }

  const port = process.env['API_PORT'] ? Number(process.env['API_PORT']) : 3001;
  const host = process.env['API_HOST'] ?? '0.0.0.0';

  let prodApp: (ApiApp & { pool: PgPool; redis: Redis }) | null = null;

  try {
    prodApp = await createProductionApp({
      databaseUrl,
      redisUrl,
      authSecret,
      seedPilotProblems: true,
      corsOrigins: parseCorsOrigins(process.env['CORS_ORIGINS']),
    });
  } catch (initErr) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Fallo al inicializar adaptadores de producción para API',
        error: initErr instanceof Error ? initErr.message : String(initErr),
      }),
    );
    process.exit(1);
  }

  const app = prodApp;

  const shutdown = async (signal: string): Promise<void> => {
    app.ctx.logger.info(`Señal ${signal} recibida; cerrando servidor API...`);
    try {
      await app.close();
      await app.redis.quit();
      await app.pool.end();
      process.exit(0);
    } catch (err) {
      app.ctx.logger.error('Error cerrando servidor API', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  app.start(port, host).catch((err: unknown) => {
    app.ctx.logger.error('Fallo al iniciar el servidor API', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
