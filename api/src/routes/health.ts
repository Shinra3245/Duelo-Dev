import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ERROR_CODES,
  runReadyChecks,
  type ApiError,
  type HealthResponse,
  type ReadyResponse,
} from '@duelodev/shared';
import type { ApiContext } from '../types.js';

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
 */
export function handleHealthz(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
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
 * Responde 200 si todas las dependencias declaradas están OK; 503 si alguna falla (H10).
 */
export async function handleReadyz(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  requestId: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendMethodNotAllowed(req, res, requestId, ['GET', 'HEAD']);
    return;
  }

  const metricSource = ctx.metrics ?? ctx.metricsProvider;
  const resolvedMetrics = typeof metricSource === 'function' ? await metricSource() : metricSource;

  const result: ReadyResponse = await runReadyChecks(ctx.serviceName, ctx.probes, resolvedMetrics);

  const statusCode = result.status === 'ready' ? 200 : 503;
  sendJson(req, res, statusCode, result);
}
