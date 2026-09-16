/** Opciones de configuración para una sonda de preparación. */
export interface ProbeOptions {
  name?: string;
  timeoutMs?: number;
}

/** Resultado estructurado retornado por una sonda de preparación de infraestructura. */
export interface ReadinessProbeResult {
  name: string;
  status: 'ready' | 'degraded';
  latency_ms: number;
  message?: string;
}

/** Sonda de verificación de dependencias para /readyz. */
export type ReadinessProbe = () => Promise<ReadinessProbeResult | void>;

/**
 * Función base para crear sondas de infraestructura con control de tiempo de expiración (timeout).
 */
export function createProbe(
  defaultName: string,
  pingFn: () => Promise<void>,
  options?: ProbeOptions,
): ReadinessProbe {
  const name = options?.name ?? defaultName;
  const timeoutMs = options?.timeoutMs ?? 3000;

  return async (): Promise<ReadinessProbeResult> => {
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        pingFn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Sonda '${name}' excedió el tiempo límite de ${timeoutMs}ms`));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);

      const latency_ms = Math.round(performance.now() - started);
      return {
        name,
        status: 'ready',
        latency_ms,
      };
    } catch (err) {
      const latency_ms = Math.round(performance.now() - started);
      const message = err instanceof Error ? err.message : String(err);
      return {
        name,
        status: 'degraded',
        latency_ms,
        message,
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };
}

/**
 * Crea una sonda de preparación para PostgreSQL que verifica la conexión mediante `pingFn`.
 */
export function createPostgresProbe(
  pingFn: () => Promise<void>,
  options?: ProbeOptions,
): ReadinessProbe {
  return createProbe('postgres', pingFn, options);
}

/**
 * Crea una sonda de preparación para Redis que verifica la conexión mediante `pingFn`.
 */
export function createRedisProbe(
  pingFn: () => Promise<void>,
  options?: ProbeOptions,
): ReadinessProbe {
  return createProbe('redis', pingFn, options);
}
