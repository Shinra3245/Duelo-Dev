import type { IncomingMessage, ServerResponse } from 'node:http';
import { ERROR_CODES, ERROR_MESSAGES } from '@duelodev/shared';
import { HttpError, parseJsonBody } from '../plugins/body-parser.js';
import { isSecureRequest, setAuthCookies } from '../plugins/cookies.js';
import {
  validateCreateRoomRequest,
  validateJoinRoomRequest,
  validateRoomCode,
} from '../schemas/rooms.js';
import type { ApiContext } from '../types.js';
import { extractAccessToken } from './auth.js';
import { sendJson } from './router.js';

/**
 * Manejador de POST /api/v1/rooms (doc 04 §2).
 */
export async function handleCreateRoom(
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

  const body = await parseJsonBody(req);
  const validated = validateCreateRoomRequest(body);
  if (!validated.ok) {
    throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, ERROR_MESSAGES.VALIDATION_FAILED, {
      errors: validated.errors,
    });
  }

  const hostHeader = req.headers['host'] ?? 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto']
    ? String(req.headers['x-forwarded-proto'])
    : 'http';
  const baseUrl = `${protocol}://${hostHeader}`;

  const result = await ctx.roomService.createRoom(session.userId, validated.data, baseUrl);
  sendJson(req, res, 201, result);
}

/**
 * Manejador de POST /api/v1/rooms/:code/join (doc 04 §2).
 */
export async function handleJoinRoom(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  roomCode: string,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    throw new HttpError(405, ERROR_CODES.VALIDATION_FAILED, 'Método no permitido. Use POST.');
  }

  const codeErr = validateRoomCode(roomCode);
  if (codeErr) {
    throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, codeErr.message, { errors: [codeErr] });
  }

  let authenticatedUserId: string | undefined;
  const rawToken = extractAccessToken(req);
  if (rawToken) {
    try {
      const session = ctx.authService.authenticateAccessToken(rawToken);
      authenticatedUserId = session.userId;
    } catch {
      // Si el token es inválido, tratamos la solicitud como nuevo invitado
    }
  }

  const body = await parseJsonBody(req);
  const validated = validateJoinRoomRequest(body);
  if (!validated.ok) {
    throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, ERROR_MESSAGES.VALIDATION_FAILED, {
      errors: validated.errors,
    });
  }

  const result = await ctx.roomService.joinRoom(roomCode, validated.data, authenticatedUserId);

  if (result.newGuestTokens) {
    setAuthCookies(res, result.newGuestTokens, isSecureRequest(req));
  }

  sendJson(req, res, 200, result.response);
}

/**
 * Manejador de GET /api/v1/rooms/:code (doc 04 §2).
 */
export async function handleGetRoomDetails(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  roomCode: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    throw new HttpError(405, ERROR_CODES.VALIDATION_FAILED, 'Método no permitido. Use GET o HEAD.');
  }

  const codeErr = validateRoomCode(roomCode);
  if (codeErr) {
    throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, codeErr.message, { errors: [codeErr] });
  }

  const rawToken = extractAccessToken(req);
  if (!rawToken) {
    throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
  }

  const session = ctx.authService.authenticateAccessToken(rawToken);
  const details = await ctx.roomService.getRoomDetails(roomCode, session.userId);

  sendJson(req, res, 200, details);
}

/**
 * Manejador de POST /api/v1/rooms/:code/start (doc 04 §2).
 */
export async function handleStartRoom(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  roomCode: string,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    throw new HttpError(405, ERROR_CODES.VALIDATION_FAILED, 'Método no permitido. Use POST.');
  }

  const codeErr = validateRoomCode(roomCode);
  if (codeErr) {
    throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, codeErr.message, { errors: [codeErr] });
  }

  const rawToken = extractAccessToken(req);
  if (!rawToken) {
    throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
  }

  const session = ctx.authService.authenticateAccessToken(rawToken);
  const startResult = await ctx.roomService.startRoom(roomCode, session.userId);

  sendJson(req, res, 200, startResult);
}
