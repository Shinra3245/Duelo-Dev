import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@duelodev/shared';
import type { ApiAppOptions, ApiContext } from './types.js';
import {
  InMemoryRefreshTokenRepository,
  InMemoryRoomRepository,
  InMemoryUserRepository,
} from './repositories/memory.js';
import { AuthService } from './services/auth.js';
import { RoomService } from './services/rooms.js';
import { dispatchRoute } from './routes/router.js';

export interface ApiApp {
  ctx: ApiContext;
  server: Server;
  requestListener: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  start: (port?: number, host?: string) => Promise<{ port: number; host: string }>;
  close: () => Promise<void>;
}

/**
 * Crea la aplicación del servicio API con su contexto, servidor HTTP y router.
 */
export function createApp(options: ApiAppOptions = {}): ApiApp {
  const serviceName = options.serviceName ?? 'api';
  const version = options.version ?? '0.1.0';
  const logger = options.logger ?? createLogger(serviceName);
  const probes = options.probes ?? {};

  const userRepo = options.userRepo ?? new InMemoryUserRepository();
  const refreshTokenRepo = options.refreshTokenRepo ?? new InMemoryRefreshTokenRepository();
  const roomRepo = options.roomRepo ?? new InMemoryRoomRepository();
  const authSecret =
    options.authSecret ??
    process.env['AUTH_SECRET'] ??
    'duelodev-default-dev-secret-change-in-production';
  const authService =
    options.authService ??
    new AuthService({
      userRepo,
      refreshTokenRepo,
      authSecret,
    });
  const roomService =
    options.roomService ??
    new RoomService({
      roomRepo,
      userRepo,
      authService,
    });

  const ctx: ApiContext = {
    serviceName,
    version,
    startTime: Date.now(),
    probes,
    logger,
    userRepo,
    refreshTokenRepo,
    roomRepo,
    authService,
    roomService,
    ...(options.metrics !== undefined ? { metrics: options.metrics } : {}),
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

    await dispatchRoute(req, res, ctx, requestId);
  };

  const server = createServer(requestListener);

  const start = (port = 3001, host = '0.0.0.0'): Promise<{ port: number; host: string }> => {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        const addr = server.address() as AddressInfo | null;
        const actualPort = addr ? addr.port : port;
        logger.info('Servidor API iniciado', {
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
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  };

  return {
    ctx,
    server,
    requestListener,
    start,
    close,
  };
}
