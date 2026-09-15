import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@duelodev/shared';
import type {
  ProblemRepository,
  RefreshTokenRepository,
  RoomRepository,
  SubmissionRepository,
  UserRepository,
} from './repositories/types.js';
import type { AuthService } from './services/auth.js';
import type { RoomService } from './services/rooms.js';
import type { SubmissionService } from './services/submissions.js';

/** Sonda de verificación de dependencias para /readyz. */
export type ReadinessProbe = () => Promise<void>;

/** Proveedor o diccionario de métricas operativas para /readyz. */
export type MetricsProvider = () => Record<string, number>;

/** Opciones de configuración para crear la aplicación API. */
export interface ApiAppOptions {
  /** Nombre del servicio para logs y health (por defecto: 'api'). */
  serviceName?: string;
  /** Versión del servicio expuesta en /healthz (por defecto: '0.1.0'). */
  version?: string;
  /** Sondas de preparación evaluadas en /readyz. */
  probes?: Record<string, ReadinessProbe>;
  /** Métricas operativas incluidas en /readyz. */
  metrics?: Record<string, number> | MetricsProvider;
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
  /** Servicio de autenticación. Si no se especifica, se instancia automáticamente. */
  authService?: AuthService;
  /** Servicio de salas. Si no se especifica, se instancia automáticamente. */
  roomService?: RoomService;
  /** Servicio de envíos y problemas públicos. Si no se especifica, se instancia automáticamente. */
  submissionService?: SubmissionService;
  /** Secreto para firma de tokens (usado al crear AuthService por defecto). */
  authSecret?: string;
}

/** Contexto compartido para el ciclo de vida de peticiones HTTP en API. */
export interface ApiContext {
  serviceName: string;
  version: string;
  startTime: number;
  probes: Record<string, ReadinessProbe>;
  metrics?: Record<string, number> | MetricsProvider;
  logger: Logger;
  userRepo: UserRepository;
  refreshTokenRepo: RefreshTokenRepository;
  roomRepo: RoomRepository;
  submissionRepo: SubmissionRepository;
  problemRepo: ProblemRepository;
  authService: AuthService;
  roomService: RoomService;
  submissionService: SubmissionService;
}

/** Firma de manejador de ruta HTTP nativo. */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  requestId: string,
) => Promise<void> | void;
