import type { IncomingMessage, ServerResponse } from 'node:http';
import { ERROR_CODES, ERROR_MESSAGES } from '@duelodev/shared';
import { HttpError, parseJsonBody } from '../plugins/body-parser.js';
import { extractIdempotencyKey } from '../plugins/idempotency.js';
import { validateCreateSubmissionRequest } from '../schemas/submissions.js';
import type { ApiContext } from '../types.js';
import { extractAccessToken } from './auth.js';
import { sendJson } from './router.js';

/**
 * Manejador de POST /api/v1/submissions (doc 04 §2).
 * Retorna 202 Accepted cuando el envío queda durablemente admitido.
 */
export async function handleCreateSubmission(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    throw new HttpError(405, ERROR_CODES.VALIDATION_FAILED, 'Método no permitido. Use POST.');
  }

  const rawToken = extractAccessToken(req);
  if (!rawToken) {
    throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
  }

  const session = ctx.authService.authenticateAccessToken(rawToken);
  const idempotencyKey = extractIdempotencyKey(req);

  const body = await parseJsonBody(req);
  const validated = validateCreateSubmissionRequest(body);
  if (!validated.ok) {
    throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, ERROR_MESSAGES.VALIDATION_FAILED, {
      errors: validated.errors,
    });
  }

  const result = await ctx.submissionService.submit(session.userId, validated.data, idempotencyKey);
  sendJson(req, res, 202, result.response);
}

/**
 * Manejador de GET /api/v1/submissions/:id (doc 04 §2).
 * Solo accesible por el dueño del envío; oculta casos de prueba y secretos.
 */
export async function handleGetSubmissionDetails(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  submissionId: string,
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
  const details = await ctx.submissionService.getSubmissionDetails(submissionId, session.userId);

  sendJson(req, res, 200, details);
}

/**
 * Manejador de GET /api/v1/problems/:id/public (doc 04 §2).
 * Devuelve únicamente enunciado y ejemplos públicos sin revelar casos ocultos.
 */
export async function handleGetProblemPublic(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  problemId: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    throw new HttpError(405, ERROR_CODES.VALIDATION_FAILED, 'Método no permitido. Use GET o HEAD.');
  }

  const rawToken = extractAccessToken(req);
  if (!rawToken) {
    throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
  }

  ctx.authService.authenticateAccessToken(rawToken);
  const publicProblem = await ctx.submissionService.getProblemPublic(problemId);

  sendJson(req, res, 200, publicProblem);
}
