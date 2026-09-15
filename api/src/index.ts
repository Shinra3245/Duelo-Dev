import { fileURLToPath } from 'node:url';
import { createApp, type ApiApp } from './app.js';

export * from './types.js';
export * from './schemas/index.js';
export * from './plugins/index.js';
export * from './routes/health.js';
export * from './routes/router.js';
export { createApp, type ApiApp };

// Inicio autónomo cuando se ejecuta directamente el archivo
const isDirectExecution =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  const port = process.env['API_PORT'] ? Number(process.env['API_PORT']) : 3001;
  const host = process.env['API_HOST'] ?? '0.0.0.0';
  const app = createApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.ctx.logger.info(`Señal ${signal} recibida; cerrando servidor API...`);
    try {
      await app.close();
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
