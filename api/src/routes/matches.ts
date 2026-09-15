import type { IncomingMessage, ServerResponse } from 'node:http';
import { ERROR_CODES, ERROR_MESSAGES } from '@duelodev/shared';
import { HttpError } from '../plugins/body-parser.js';
import type { ApiContext } from '../types.js';
import { extractAccessToken } from './auth.js';
import { sendJson } from './router.js';

/**
 * Manejador de GET /api/v1/matches/:id/summary (doc 04 §2).
 * Solo accesible por miembros de una partida terminada; retorna clasificación y snapshots revelados.
 */
export async function handleGetMatchSummary(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  matchId: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    throw new HttpError(405, ERROR_CODES.VALIDATION_FAILED, 'Método no permitido. Use GET o HEAD.');
  }

  const rawToken = extractAccessToken(req);
  if (!rawToken) {
    throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
  }

  const session = ctx.authService.authenticateAccessToken(rawToken);
  const summary = await ctx.roomService.getMatchSummary(matchId, session.userId);

  sendJson(req, res, 200, summary);
}
