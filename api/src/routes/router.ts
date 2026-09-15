import type { IncomingMessage, ServerResponse } from 'node:http';
import { ERROR_CODES, ERROR_MESSAGES, type ApiError } from '@duelodev/shared';
import type { ApiContext } from '../types.js';
import { HttpError } from '../plugins/body-parser.js';
import { handleHealthz, handleReadyz } from './health.js';

export function sendJson(
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

/**
 * Despacha la solicitud HTTP a la ruta correspondiente o responde 404/500 con formato ApiError.
 */
export async function dispatchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  requestId: string,
): Promise<void> {
  try {
    const rawUrl = req.url ?? '/';
    const parsedUrl = new URL(rawUrl, 'http://localhost');
    const pathname = parsedUrl.pathname;

    if (pathname === '/healthz') {
      handleHealthz(req, res, ctx, requestId);
      return;
    }

    if (pathname === '/readyz') {
      await handleReadyz(req, res, ctx, requestId);
      return;
    }

    const notFoundBody: ApiError = {
      error: {
        code: ERROR_CODES.NOT_FOUND,
        message: ERROR_MESSAGES.NOT_FOUND,
        request_id: requestId,
      },
    };
    sendJson(req, res, 404, notFoundBody);
  } catch (err) {
    if (err instanceof HttpError) {
      if (!res.headersSent) {
        sendJson(req, res, err.statusCode, err.toApiError(requestId));
      } else {
        res.end();
      }
      return;
    }

    ctx.logger.error('Error no capturado procesando solicitud', {
      request_id: requestId,
      url: req.url,
      method: req.method,
      error: err instanceof Error ? err.message : String(err),
    });

    if (!res.headersSent) {
      const internalBody: ApiError = {
        error: {
          code: ERROR_CODES.INTERNAL,
          message: ERROR_MESSAGES.INTERNAL,
          request_id: requestId,
        },
      };
      sendJson(req, res, 500, internalBody);
    } else {
      res.end();
    }
  }
}
