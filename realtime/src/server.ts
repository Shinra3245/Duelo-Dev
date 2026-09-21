import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger, ERROR_CODES, type ApiError } from '@duelodev/shared';
import type { RealtimeAppOptions, RealtimeContext } from './types.js';
import { InMemoryMatchStore } from './store/memory.js';
import { handleHealthz, handleReadyz } from './routes/health.js';
import { MatchHub } from './socket/hub.js';
import { YjsHub } from './yjs/hub.js';
import {
  setupRealtimeUpgradeHandler,
  type RealtimeUpgradeController,
} from './transport/adapter.js';
import { InMemoryProcessedSubmissionStore } from './queue/memory.js';
import { JudgeResultsConsumer } from './queue/consumer.js';
import { MatchStateReconciler } from './queue/reconciler.js';
import type { ProcessedSubmissionStore } from './queue/types.js';

export interface RealtimeServer {
  server: Server;
  ctx: RealtimeContext;
  matchHub: MatchHub;
  yjsHub: YjsHub;
  upgradeController: RealtimeUpgradeController;
  resultsConsumer?: JudgeResultsConsumer | undefined;
  stateReconciler?: MatchStateReconciler | undefined;
  processedSubmissionStore?: ProcessedSubmissionStore | undefined;
  requestListener: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  start: (port?: number, host?: string) => Promise<{ port: number; host: string }>;
  close: () => Promise<void>;
}

/**
 * Crea la instancia del servidor HTTP base de Realtime con soporte de health, readiness y MatchStore.
 */
export function createRealtimeServer(options: RealtimeAppOptions = {}): RealtimeServer {
  const serviceName = options.serviceName ?? 'realtime';
  const version = options.version ?? '0.1.0';
  const matchStore = options.matchStore ?? new InMemoryMatchStore();
  const logger = options.logger ?? createLogger(serviceName);
  const startTime = Date.now();
  const readinessProbes = options.readinessProbes ? [...options.readinessProbes] : [];
  const authSecret =
    options.authSecret ?? process.env['AUTH_SECRET'] ?? 'dev-secret-key-change-in-production';

  const yjsHub = new YjsHub({
    matchStore,
    logger,
    snapshotIntervalMs: options.yjsSnapshotIntervalMs,
    onSnapshotPersist: options.onYjsSnapshotPersist,
  });

  const matchHub = new MatchHub({
    matchStore,
    logger,
    reconnectGraceMs: options.reconnectGraceMs,
    onRevealChanged: (matchId, userId) => yjsHub.notifyRevealChanged(matchId, userId),
  });

  const processedSubmissionStore =
    options.processedSubmissionStore ?? new InMemoryProcessedSubmissionStore();

  let resultsConsumer: JudgeResultsConsumer | undefined;
  if (options.resultSubscriber) {
    resultsConsumer = new JudgeResultsConsumer({
      subscriber: options.resultSubscriber,
      matchHub,
      matchStore,
      processedStore: processedSubmissionStore,
      submissionProvider: options.submissionProvider,
      logger,
    });
    resultsConsumer.start();
  }

  let stateReconciler: MatchStateReconciler | undefined;
  if (options.submissionProvider) {
    stateReconciler = new MatchStateReconciler({
      matchStore,
      matchHub,
      submissionProvider: options.submissionProvider,
      processedStore: processedSubmissionStore,
      intervalMs: options.reconciliationIntervalMs,
      logger,
    });
    stateReconciler.start();
  }

  const unsubscribeMatchControl = options.matchControlSubscriber?.subscribe(
    async (notification) => {
      if (notification.type === 'match_closed') {
        await matchHub.closeMatchFromAdmin(notification.match_id, notification.state_version);
        return;
      }
      const match = await matchStore.getMatch(notification.match_id);
      if (match) {
        await matchHub.startMatch(notification.match_id, match.problem_ids ?? []);
      }
    },
  );

  const ctx: RealtimeContext = {
    serviceName,
    version,
    matchStore,
    logger,
    startTime,
    readinessProbes,
    authSecret,
    resultSubscriber: options.resultSubscriber,
    submissionProvider: options.submissionProvider,
    processedSubmissionStore,
    reconciliationIntervalMs: options.reconciliationIntervalMs,
    resultsConsumer,
    stateReconciler,
    matchControlSubscriber: options.matchControlSubscriber,
  };

  const requestListener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const headerReqId = req.headers['x-request-id'];
    const requestId =
      typeof headerReqId === 'string' && headerReqId.length > 0 ? headerReqId : randomUUID();

    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');

    const reqStart = performance.now();

    res.on('finish', () => {
      const elapsedMs = Math.round(performance.now() - reqStart);
      logger.info('Solicitud HTTP completada', {
        request_id: requestId,
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration_ms: elapsedMs,
      });
    });

    try {
      const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
      const pathname = parsedUrl.pathname;

      if (pathname === '/healthz') {
        handleHealthz(req, res, ctx, requestId);
        return;
      }

      if (pathname === '/readyz') {
        await handleReadyz(req, res, ctx, requestId);
        return;
      }

      // Ruta desconocida (404)
      const errBody: ApiError = {
        error: {
          code: ERROR_CODES.NOT_FOUND,
          message: 'Ruta no encontrada.',
          details: { pathname },
          request_id: requestId,
        },
      };
      const body = JSON.stringify(errBody);
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-length', Buffer.byteLength(body));
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(body);
    } catch (err) {
      logger.error('Error no controlado al procesar solicitud', {
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      });

      if (!res.headersSent) {
        const errBody: ApiError = {
          error: {
            code: ERROR_CODES.INTERNAL,
            message: 'Algo falló de nuestro lado. Ya lo estamos viendo.',
            details: {
              error: err instanceof Error ? err.message : String(err),
            },
            request_id: requestId,
          },
        };
        const body = JSON.stringify(errBody);
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('content-length', Buffer.byteLength(body));
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.end(body);
      }
    }
  };

  const server = createServer(requestListener);

  const upgradeController = setupRealtimeUpgradeHandler({
    server,
    matchHub,
    yjsHub,
    authSecret,
    matchStore,
    logger,
  });

  const start = async (port = 4000, host = '0.0.0.0'): Promise<{ port: number; host: string }> => {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        const addr = server.address() as AddressInfo | null;
        const actualPort = addr ? addr.port : port;
        logger.info('Servidor Realtime iniciado', {
          port: actualPort,
          host,
          service: serviceName,
          version,
        });
        resolve({ port: actualPort, host });
      });
    });
  };

  const close = (): Promise<void> => {
    resultsConsumer?.stop();
    stateReconciler?.stop();
    unsubscribeMatchControl?.();
    upgradeController.close();
    matchHub.clearAllTimers();
    yjsHub.close();
    return new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((err) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  };

  return {
    server,
    ctx,
    matchHub,
    yjsHub,
    upgradeController,
    resultsConsumer,
    stateReconciler,
    processedSubmissionStore,
    requestListener,
    start,
    close,
  };
}
