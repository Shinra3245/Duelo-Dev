import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@duelodev/shared';
import type {
  EventRepository,
  ProblemRepository,
  RefreshTokenRepository,
  RoomRepository,
  SubmissionRepository,
  UserRepository,
} from './repositories/types.js';
import type { AuthService } from './services/auth.js';
import type { RoomService } from './services/rooms.js';
import type { SubmissionService } from './services/submissions.js';
import type { JudgmentService } from './services/judgment.js';
import type { RetentionService, RetentionServiceOptions } from './services/retention.js';
import type { AuditService } from './services/audit.js';
import type { JudgeQueue, SubmissionReconciler, ResultPublisher } from './queue/index.js';
import type { CsrfOptions } from './plugins/csrf.js';
import type { CorsOptions } from './plugins/cors.js';
import type { RateLimiter } from './plugins/rate-limit.js';
import type { ReadinessProbe, ReadinessProbeResult } from './infrastructure/probes.js';
import type { AdminService } from './services/admin.js';
import type { MatchControlPublisher } from './queue/control.js';

export type { ReadinessProbe, ReadinessProbeResult };

/** Proveedor o diccionario de métricas operativas para /readyz. */
export type MetricsProvider = () => Promise<Record<string, number>> | Record<string, number>;

/** Configuración de tasa para autenticación pública. */
export interface RateLimitConfig {
  registerLimit?: number;
  loginLimit?: number;
  windowMs?: number;
  enabled?: boolean;
}

/** Opciones de configuración para crear la aplicación API. */
export interface ApiAppOptions {
  /** Nombre del servicio para logs y health (por defecto: 'api'). */
  serviceName?: string;
  /** Versión del servicio expuesta en /healthz (por defecto: '0.1.0'). */
  version?: string;
  /** Sondas de preparación evaluadas en /readyz. */
  probes?: Record<string, ReadinessProbe>;
  /** Ping de base de datos evaluado en /readyz. */
  databasePing?: () => Promise<void>;
  /** Ping de Redis evaluado en /readyz. */
  redisPing?: () => Promise<void>;
  /** Instancia personalizada del limitador de tasa para autenticación. */
  rateLimiter?: RateLimiter;
  /** Opciones de configuración de rate limiting para autenticación. */
  rateLimitConfig?: {
    registerLimit?: number;
    loginLimit?: number;
    windowMs?: number;
    enabled?: boolean;
  };
  /** Métricas operativas incluidas en /readyz. */
  metrics?: Record<string, number> | MetricsProvider;
  /** Proveedor personalizado de métricas operativas para /readyz. */
  metricsProvider?: MetricsProvider;
  /** Instancia personalizada del logger estructurado. */
  logger?: Logger;
  /** Repositorio de usuarios. Si no se especifica, se crea uno en memoria. */
  userRepo?: UserRepository;
  /** Repositorio de refresh tokens. Si no se especifica, se crea uno en memoria. */
  refreshTokenRepo?: RefreshTokenRepository;
  /** Repositorio de salas y partidas. Si no se especifica, se crea uno en memoria. */
  roomRepo?: RoomRepository;
  /** Repositorio de envíos. Si no se especifica, se crea uno en memoria. */
  submissionRepo?: SubmissionRepository;
  /** Repositorio de problemas. Si no se especifica, se crea uno en memoria. */
  problemRepo?: ProblemRepository;
  /** Repositorio de eventos de auditoría y producto. Si no se especifica, se crea uno en memoria. */
  eventRepo?: EventRepository;
  /** Cola de ejecución del juez. Si no se especifica, se crea una en memoria. */
  judgeQueue?: JudgeQueue;
  /** Reconciliador de envíos pendientes. Si no se especifica, se instancia automáticamente. */
  submissionReconciler?: SubmissionReconciler;
  /** Servicio de autenticación. Si no se especifica, se instancia automáticamente. */
  authService?: AuthService;
  /** Servicio de salas. Si no se especifica, se instancia automáticamente. */
  roomService?: RoomService;
  /** Servicio de envíos y problemas públicos. Si no se especifica, se instancia automáticamente. */
  submissionService?: SubmissionService;
  /** Servicio de auditoría y registro de eventos. Si no se especifica, se instancia automáticamente. */
  auditService?: AuditService;
  /** Servicio de operaciones protegidas del panel administrativo. */
  adminService?: AdminService;
  /** Publicador interno para reflejar cierres administrativos en Realtime. */
  matchControlPublisher?: MatchControlPublisher;
  /** Publicador de avisos de resultados en judge:results. Si no se especifica, se crea uno en memoria. */
  resultPublisher?: ResultPublisher;
  /** Servicio de aplicación de resultados durables del juez. Si no se especifica, se instancia automáticamente. */
  judgmentService?: JudgmentService;
  /** Servicio de retención y purga de invitados. Si no se especifica, se instancia automáticamente. */
  retentionService?: RetentionService;
  /** Opciones de configuración para el servicio de retención y purga de invitados. */
  retentionOptions?: RetentionServiceOptions;
  /** Opciones de verificación de origen y CSRF. */
  csrfOptions?: CsrfOptions;
  /** Opciones CORS para clientes web en otro origen permitido. */
  corsOptions?: CorsOptions;
  /** Secreto para firma de tokens (usado al crear AuthService por defecto). */
  authSecret?: string;
  /** Si es true, siembra los problemas piloto en problemRepo al iniciar la app. */
  seedPilotProblems?: boolean;
  /** Si es true, los invitados se anonimizan al cerrar su sesión. */
  ephemeralGuestSessions?: boolean;
}

/** Contexto compartido para el ciclo de vida de peticiones HTTP en API. */
export interface ApiContext {
  serviceName: string;
  version: string;
  startTime: number;
  probes: Record<string, ReadinessProbe>;
  metrics?: Record<string, number> | MetricsProvider;
  metricsProvider?: MetricsProvider;
  logger: Logger;
  userRepo: UserRepository;
  refreshTokenRepo: RefreshTokenRepository;
  roomRepo: RoomRepository;
  submissionRepo: SubmissionRepository;
  problemRepo: ProblemRepository;
  eventRepo?: EventRepository;
  judgeQueue: JudgeQueue;
  submissionReconciler: SubmissionReconciler;
  resultPublisher: ResultPublisher;
  judgmentService: JudgmentService;
  authService: AuthService;
  roomService: RoomService;
  submissionService: SubmissionService;
  retentionService: RetentionService;
  ephemeralGuestSessions: boolean;
  auditService?: AuditService;
  adminService: AdminService;
  csrfOptions?: CsrfOptions;
  rateLimiter?: RateLimiter;
  rateLimitConfig?: {
    registerLimit?: number;
    loginLimit?: number;
    windowMs?: number;
    enabled?: boolean;
  };
}

/** Firma de manejador de ruta HTTP nativo. */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  requestId: string,
) => Promise<void> | void;
