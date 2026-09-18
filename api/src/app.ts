import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@duelodev/shared';
import type { ApiAppOptions, ApiContext, ReadinessProbe } from './types.js';
import { RateLimiter } from './plugins/rate-limit.js';
import { createPostgresProbe, createRedisProbe } from './infrastructure/probes.js';
import {
  InMemoryEventRepository,
  InMemoryProblemRepository,
  InMemoryRefreshTokenRepository,
  InMemoryRoomRepository,
  InMemorySubmissionRepository,
  InMemoryUserRepository,
} from './repositories/memory.js';
import { AuthService } from './services/auth.js';
import { RoomService } from './services/rooms.js';
import { SubmissionService } from './services/submissions.js';
import { InMemoryJudgeQueue, InMemoryResultChannel, SubmissionReconciler } from './queue/index.js';
import { seedProblems } from './seeds/seeder.js';
import { JudgmentService } from './services/judgment.js';
import { RetentionService } from './services/retention.js';
import { AuditService } from './services/audit.js';
import { createOperationalMetricsProvider } from './services/metrics.js';
import { validateCsrfOrigin } from './plugins/csrf.js';
import { applyCorsHeaders, handleCorsPreflight } from './plugins/cors.js';
import { HttpError } from './plugins/body-parser.js';
import { dispatchRoute } from './routes/router.js';
import { AdminService } from './services/admin.js';

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
  const startTime = Date.now();
  const serviceName = options.serviceName ?? 'api';
  const version = options.version ?? '0.1.0';
  const logger = options.logger ?? createLogger(serviceName);
  const probes: Record<string, ReadinessProbe> = { ...(options.probes ?? {}) };
  if (options.databasePing) {
    probes['postgres'] = createPostgresProbe(options.databasePing);
  }
  if (options.redisPing) {
    probes['redis'] = createRedisProbe(options.redisPing);
  }

  const rateLimiter =
    options.rateLimitConfig?.enabled !== false
      ? (options.rateLimiter ??
        new RateLimiter(
          options.rateLimitConfig?.windowMs !== undefined
            ? { windowMs: options.rateLimitConfig.windowMs }
            : undefined,
        ))
      : undefined;

  const userRepo = options.userRepo ?? new InMemoryUserRepository();
  const refreshTokenRepo = options.refreshTokenRepo ?? new InMemoryRefreshTokenRepository();
  const roomRepo = options.roomRepo ?? new InMemoryRoomRepository();
  const submissionRepo = options.submissionRepo ?? new InMemorySubmissionRepository();
  const problemRepo = options.problemRepo ?? new InMemoryProblemRepository();
  const eventRepo = options.eventRepo ?? new InMemoryEventRepository();
  const judgeQueue = options.judgeQueue ?? new InMemoryJudgeQueue();
  const auditService = options.auditService ?? new AuditService(eventRepo, logger);
  const adminService =
    options.adminService ??
    new AdminService({
      roomRepo,
      userRepo,
      auditService,
      ...(options.matchControlPublisher
        ? { matchControlPublisher: options.matchControlPublisher }
        : {}),
    });

  const defaultMetricsProvider = createOperationalMetricsProvider(
    { roomRepo, submissionRepo, userRepo, eventRepo },
    startTime,
  );
  const metricsProvider = options.metricsProvider ?? defaultMetricsProvider;
  const metrics =
    options.metrics !== undefined
      ? options.metrics
      : (options.metricsProvider ?? defaultMetricsProvider);

  const submissionReconciler =
    options.submissionReconciler ??
    new SubmissionReconciler({
      submissionRepo,
      queue: judgeQueue,
      problemRepo,
      matchRepo: roomRepo,
      logger,
    });

  const authSecret =
    options.authSecret ??
    process.env['AUTH_SECRET'] ??
    'duelodev-default-dev-secret-change-in-production';
  const ephemeralGuestSessions =
    options.ephemeralGuestSessions ?? process.env['EPHEMERAL_GUEST_SESSIONS'] === '1';
  const authService =
    options.authService ??
    new AuthService({
      userRepo,
      refreshTokenRepo,
      authSecret,
      auditService,
    });
  const roomService =
    options.roomService ??
    new RoomService({
      roomRepo,
      userRepo,
      authService,
      auditService,
    });
  const submissionService =
    options.submissionService ??
    new SubmissionService({
      submissionRepo,
      roomRepo,
      problemRepo,
      judgeQueue,
      logger,
      auditService,
    });

  const resultPublisher = options.resultPublisher ?? new InMemoryResultChannel();
  const judgmentService =
    options.judgmentService ??
    new JudgmentService({
      submissionRepo,
      resultPublisher,
      logger,
    });
  const retentionService =
    options.retentionService ??
    new RetentionService(
      userRepo,
      refreshTokenRepo,
      roomRepo,
      options.retentionOptions,
      logger,
      auditService,
    );

  const ctx: ApiContext = {
    serviceName,
    version,
    startTime,
    probes,
    logger,
    userRepo,
    refreshTokenRepo,
    roomRepo,
    submissionRepo,
    problemRepo,
    eventRepo,
    judgeQueue,
    submissionReconciler,
    resultPublisher,
    judgmentService,
    authService,
    roomService,
    submissionService,
    retentionService,
    ephemeralGuestSessions,
    auditService,
    adminService,
    metricsProvider,
    metrics,
    ...(rateLimiter !== undefined ? { rateLimiter } : {}),
    ...(options.rateLimitConfig !== undefined ? { rateLimitConfig: options.rateLimitConfig } : {}),
    ...(options.csrfOptions !== undefined ? { csrfOptions: options.csrfOptions } : {}),
  };

  const requestListener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const headerReqId = req.headers['x-request-id'];
    const requestId =
      typeof headerReqId === 'string' && headerReqId.length > 0 ? headerReqId : randomUUID();

    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');

    applyCorsHeaders(req, res, options.corsOptions);
    if (handleCorsPreflight(req, res, options.corsOptions)) {
      return;
    }

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

    // Control de origen y protección CSRF para operaciones de mutación (doc 04 §2)
    try {
      validateCsrfOrigin(req, options.csrfOptions);
    } catch (csrfErr) {
      if (csrfErr instanceof HttpError) {
        res.setHeader('content-type', 'application/json');
        res.statusCode = csrfErr.statusCode;
        res.end(JSON.stringify(csrfErr.toApiError(requestId)));
        return;
      }
      throw csrfErr;
    }

    await dispatchRoute(req, res, ctx, requestId);
  };

  const server = createServer(requestListener);

  const start = async (port = 3001, host = '0.0.0.0'): Promise<{ port: number; host: string }> => {
    if (options.seedPilotProblems) {
      await seedProblems(problemRepo);
    }

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
        submissionReconciler.start();
        resolve({ port: actualPort, host });
      });
    });
  };

  const close = (): Promise<void> => {
    submissionReconciler.stop();
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
