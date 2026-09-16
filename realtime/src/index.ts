import { fileURLToPath } from 'node:url';
import pg from 'pg';
const { Pool } = pg;
import type { Pool as PgPool } from 'pg';
import { Redis } from 'ioredis';
import { createRealtimeServer, type RealtimeServer } from './server.js';
import { InMemoryMatchStore } from './store/memory.js';
import { PostgresMatchStore } from './store/postgres.js';
import { PostgresProcessedSubmissionStore, PostgresSubmissionProvider } from './queue/postgres.js';
import { RedisResultSubscriber } from './queue/redis.js';
import type { ReadinessProbe } from './types.js';

export * from './types.js';
export * from './store/index.js';
export * from './routes/health.js';
export * from './socket/index.js';
export * from './yjs/index.js';
export * from './gamemodes/index.js';
export * from './transport/index.js';
export * from './queue/index.js';
export { createRealtimeServer, type RealtimeServer };
export { InMemoryMatchStore };

export interface ProductionRealtimeConfig {
  databaseUrl: string;
  redisUrl: string;
  authSecret: string;
  reconnectGraceMs?: number;
  reconciliationIntervalMs?: number;
}

/**
 * Crea el servidor Realtime configurado con adaptadores durables de producción
 * (PostgreSQL para MatchStore, ProcessedSubmissionStore y SubmissionProvider;
 * Redis Pub/Sub para ResultSubscriber). Exige conexiones activas al arrancar.
 */
export async function createProductionRealtimeServer(config: ProductionRealtimeConfig): Promise<
  RealtimeServer & {
    pool: PgPool;
    redis: Redis;
    resultSubscriber: RedisResultSubscriber;
  }
> {
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

  const redis = new Redis(config.redisUrl);
  await redis.ping();

  const matchStore = new PostgresMatchStore(pool);
  const processedSubmissionStore = new PostgresProcessedSubmissionStore(pool);
  const submissionProvider = new PostgresSubmissionProvider(pool);
  const resultSubscriber = new RedisResultSubscriber({ redis });

  const readinessProbes: ReadinessProbe[] = [
    {
      name: 'postgres',
      check: async () => {
        await pool.query('SELECT 1');
      },
    },
    {
      name: 'redis',
      check: async () => {
        await redis.ping();
      },
    },
  ];

  const server = createRealtimeServer({
    matchStore,
    processedSubmissionStore,
    submissionProvider,
    resultSubscriber,
    authSecret: config.authSecret,
    readinessProbes,
    ...(config.reconnectGraceMs !== undefined ? { reconnectGraceMs: config.reconnectGraceMs } : {}),
    ...(config.reconciliationIntervalMs !== undefined
      ? { reconciliationIntervalMs: config.reconciliationIntervalMs }
      : {}),
  });

  const originalClose = server.close.bind(server);
  const extendedClose = async (): Promise<void> => {
    await originalClose();
    await resultSubscriber.close();
    await redis.quit();
    await pool.end();
  };

  return Object.assign(server, {
    pool,
    redis,
    resultSubscriber,
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
        message: `Faltan variables de entorno requeridas para producción en Realtime: ${missing.join(', ')}`,
      }),
    );
    process.exit(1);
  }

  const envPort = process.env['REALTIME_PORT'] ?? process.env['PORT'];
  const port = envPort ? Number(envPort) : 4000;
  const host = process.env['REALTIME_HOST'] ?? process.env['HOST'] ?? '0.0.0.0';

  let prodServer:
    | (RealtimeServer & {
        pool: PgPool;
        redis: Redis;
        resultSubscriber: RedisResultSubscriber;
      })
    | null = null;

  try {
    prodServer = await createProductionRealtimeServer({
      databaseUrl,
      redisUrl,
      authSecret,
    });
  } catch (initErr) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Fallo al inicializar adaptadores de producción para Realtime',
        error: initErr instanceof Error ? initErr.message : String(initErr),
      }),
    );
    process.exit(1);
  }

  const server = prodServer;

  const shutdown = async (signal: string): Promise<void> => {
    server.ctx.logger.info(`Señal ${signal} recibida; cerrando servidor Realtime...`);
    try {
      await server.close();
      process.exit(0);
    } catch (err) {
      server.ctx.logger.error('Error cerrando servidor Realtime', {
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

  server.start(port, host).catch((err: unknown) => {
    server.ctx.logger.error('Fallo al iniciar el servidor Realtime', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
