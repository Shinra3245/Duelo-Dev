import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@duelodev/shared';

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
}

/** Contexto compartido para el ciclo de vida de peticiones HTTP en API. */
export interface ApiContext {
  serviceName: string;
  version: string;
  startTime: number;
  probes: Record<string, ReadinessProbe>;
  metrics?: Record<string, number> | MetricsProvider;
  logger: Logger;
}

/** Firma de manejador de ruta HTTP nativo. */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  requestId: string,
) => Promise<void> | void;
