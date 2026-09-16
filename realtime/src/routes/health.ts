import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ERROR_CODES,
  runReadyChecks,
  type ApiError,
  type HealthResponse,
  type ReadyResponse,
} from '@duelodev/shared';
import type { RealtimeContext } from '../types.js';

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  const body = JSON.stringify(data);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.end(body);
}

function sendMethodNotAllowed(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  allowed: string[],
): void {
  res.setHeader('allow', allowed.join(', '));
  const errBody: ApiError = {
    error: {
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'Método HTTP no permitido.',
      details: {
        method: req.method ?? 'UNKNOWN',
        allowed,
      },
      request_id: requestId,
    },
  };
  sendJson(req, res, 405, errBody);
}

/**
 * Maneja solicitudes a `/healthz`.
 * Responde 200 OK con `HealthResponse` si el proceso vive (H10).
 * Soporta métodos GET y HEAD; rechaza cualquier otro con 405.
 */
export function handleHealthz(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RealtimeContext,
  requestId: string,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendMethodNotAllowed(req, res, requestId, ['GET', 'HEAD']);
    return;
  }

  const uptime_s = Math.round(((Date.now() - ctx.startTime) / 1000) * 100) / 100;
  const payload: HealthResponse = {
    status: 'ok',
    service: ctx.serviceName,
    uptime_s,
    version: ctx.version,
  };

  sendJson(req, res, 200, payload);
}

/**
 * Maneja solicitudes a `/readyz`.
 * Evalúa sondas de preparación y métricas dinámicas (`active_matches`, `uptime_s`).
 * Responde 200 con `ReadyResponse` si todas las dependencias están OK; 503 si alguna falla.
 * Soporta métodos GET y HEAD; rechaza cualquier otro con 405.
 */
export async function handleReadyz(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RealtimeContext,
  requestId: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendMethodNotAllowed(req, res, requestId, ['GET', 'HEAD']);
    return;
  }

  const activeMatches = await ctx.matchStore.countActiveMatches();
  const uptime_s = Math.round(((Date.now() - ctx.startTime) / 1000) * 100) / 100;

  const probes: Record<string, () => Promise<void>> = {};
  for (const probe of ctx.readinessProbes) {
    probes[probe.name] = probe.check;
  }

  const metrics: Record<string, number> = {
    active_matches: activeMatches,
    uptime_s,
  };

  const result: ReadyResponse = await runReadyChecks(ctx.serviceName, probes, metrics);

  const statusCode = result.status === 'ready' ? 200 : 503;
  sendJson(req, res, statusCode, result);
}
