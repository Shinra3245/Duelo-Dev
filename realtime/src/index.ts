import { fileURLToPath } from 'node:url';
import { createRealtimeServer, type RealtimeServer } from './server.js';
import { InMemoryMatchStore } from './store/memory.js';

export * from './types.js';
export * from './store/index.js';
export * from './routes/health.js';
export * from './socket/index.js';
export * from './yjs/index.js';
export { createRealtimeServer, type RealtimeServer };
export { InMemoryMatchStore };

// Inicio autónomo cuando se ejecuta directamente el archivo
const isDirectExecution =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  const envPort = process.env['REALTIME_PORT'] ?? process.env['PORT'];
  const port = envPort ? Number(envPort) : 4000;
  const host = process.env['REALTIME_HOST'] ?? process.env['HOST'] ?? '0.0.0.0';
  const server = createRealtimeServer();

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
