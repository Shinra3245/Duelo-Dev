/**
 * Contrato de `/healthz` y `/readyz` (contexto H10).
 *
 * `/healthz` responde 200 si el proceso vive. `/readyz` responde 200 solo si
 * todas las dependencias declaradas están OK; si no, 503. El reverse proxy y el
 * runbook del evento se apoyan en esta distinción.
 */
export interface HealthResponse {
  status: 'ok';
  service: string;
  uptime_s: number;
  version: string;
}

export interface ReadyCheck {
  name: string;
  ok: boolean;
  latency_ms?: number;
  error?: string;
}

export interface ReadyResponse {
  status: 'ready' | 'degraded';
  service: string;
  checks: ReadyCheck[];
  /** Métricas operativas ligeras; el Realtime expone aquí `ydocs_activos` (H12). */
  metrics?: Record<string, number>;
}

/** Ejecuta las sondas en paralelo y arma la respuesta de `/readyz`. */
export async function runReadyChecks(
  service: string,
  probes: Record<string, () => Promise<void>>,
  metrics?: Record<string, number>,
): Promise<ReadyResponse> {
  const checks = await Promise.all(
    Object.entries(probes).map(async ([name, probe]): Promise<ReadyCheck> => {
      const started = performance.now();
      try {
        await probe();
        return { name, ok: true, latency_ms: Math.round(performance.now() - started) };
      } catch (err) {
        return {
          name,
          ok: false,
          latency_ms: Math.round(performance.now() - started),
          error: err instanceof Error ? err.message : 'error desconocido',
        };
      }
    }),
  );

  return {
    status: checks.every((c) => c.ok) ? 'ready' : 'degraded',
    service,
    checks,
    ...(metrics ? { metrics } : {}),
  };
}
