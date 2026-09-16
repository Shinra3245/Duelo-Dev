import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  type AuthUserResponse,
  type LogoutResponse,
} from '@duelodev/shared';
import { HttpError, parseJsonBody } from '../plugins/body-parser.js';
import {
  AUTH_COOKIE_NAMES,
  clearAuthCookies,
  getRequestCookies,
  setAuthCookies,
} from '../plugins/cookies.js';
import {
  validateConvertGuestRequest,
  validateLoginRequest,
  validateRegisterRequest,
} from '../schemas/auth.js';
import type { ApiContext } from '../types.js';
import { sendJson } from './router.js';

/**
 * Extrae el access token desde cookies o desde la cabecera Authorization (Bearer).
 */
export function extractAccessToken(req: IncomingMessage): string | null {
  const cookies = getRequestCookies(req);
  if (cookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN]) {
    return cookies[AUTH_COOKIE_NAMES.ACCESS_TOKEN] ?? null;
  }

  const authHeader = req.headers['authorization'];
  if (authHeader && typeof authHeader === 'string') {
    const trimmed = authHeader.trim();
    if (trimmed.startsWith('Bearer ')) {
      return trimmed.slice(7).trim();
    }
  }

  return null;
}

/**
 * Extrae el refresh token desde cookies o secundariamente desde el cuerpo JSON.
 */
export async function extractRefreshToken(req: IncomingMessage): Promise<string | null> {
  const cookies = getRequestCookies(req);
  if (cookies[AUTH_COOKIE_NAMES.REFRESH_TOKEN]) {
    return cookies[AUTH_COOKIE_NAMES.REFRESH_TOKEN] ?? null;
  }

  // Si no está en cookies, intenta extraerlo del cuerpo si es POST
  if (req.method === 'POST') {
    try {
      const body = (await parseJsonBody(req)) as Record<string, unknown>;
      if (body && typeof body['refresh_token'] === 'string') {
        return body['refresh_token'];
      }
    } catch {
      // Ignorar fallo de parseo si no era JSON
    }
  }

  return null;
}

/**
 * Manejador de POST /api/v1/auth/register (doc 04 §2).
 */
export async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    throw new HttpError(405, ERROR_CODES.VALIDATION_FAILED, 'Método no permitido. Use POST.');
  }

  ctx.rateLimiter?.check(req, res, 'register', ctx.rateLimitConfig?.registerLimit ?? 10);

  const body = await parseJsonBody(req);
  const validated = validateRegisterRequest(body);
  if (!validated.ok) {
    throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, ERROR_MESSAGES.VALIDATION_FAILED, {
      errors: validated.errors,
    });
  }

  const result = await ctx.authService.register(validated.data);
  setAuthCookies(res, {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });

  const responseBody: AuthUserResponse = { user: result.user };
  sendJson(req, res, 201, responseBody);
}

/**
 * Manejador de POST /api/v1/auth/login (doc 04 §2).
 */
export async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    throw new HttpError(405, ERROR_CODES.VALIDATION_FAILED, 'Método no permitido. Use POST.');
  }

  ctx.rateLimiter?.check(req, res, 'login', ctx.rateLimitConfig?.loginLimit ?? 15);

  const body = await parseJsonBody(req);
  const validated = validateLoginRequest(body);
  if (!validated.ok) {
    throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, ERROR_MESSAGES.VALIDATION_FAILED, {
      errors: validated.errors,
    });
  }

  const result = await ctx.authService.login(validated.data);
  setAuthCookies(res, {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });

  const responseBody: AuthUserResponse = { user: result.user };
  sendJson(req, res, 200, responseBody);
}

/**
 * Manejador de POST /api/v1/auth/refresh (doc 04 §2).
 */
export async function handleRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    throw new HttpError(405, ERROR_CODES.VALIDATION_FAILED, 'Método no permitido. Use POST.');
  }

  const refreshToken = await extractRefreshToken(req);
  if (!refreshToken) {
    throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
  }

  const result = await ctx.authService.refresh(refreshToken);
  setAuthCookies(res, {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });

  const responseBody: AuthUserResponse = { user: result.user };
  sendJson(req, res, 200, responseBody);
}

/**
 * Manejador de POST /api/v1/auth/logout (doc 04 §2).
 */
export async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    throw new HttpError(405, ERROR_CODES.VALIDATION_FAILED, 'Método no permitido. Use POST.');
  }

  const refreshToken = await extractRefreshToken(req);
  if (refreshToken) {
    await ctx.authService.logout(refreshToken);
  }

  clearAuthCookies(res);
  const responseBody: LogoutResponse = { ok: true };
  sendJson(req, res, 200, responseBody);
}

/**
 * Manejador de POST /api/v1/users/convert (doc 04 §2).
 */
export async function handleConvertGuest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    throw new HttpError(405, ERROR_CODES.VALIDATION_FAILED, 'Método no permitido. Use POST.');
  }

  const rawAccessToken = extractAccessToken(req);
  if (!rawAccessToken) {
    throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
  }

  const session = ctx.authService.authenticateAccessToken(rawAccessToken);

  const body = await parseJsonBody(req);
  const validated = validateConvertGuestRequest(body);
  if (!validated.ok) {
    throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, ERROR_MESSAGES.VALIDATION_FAILED, {
      errors: validated.errors,
    });
  }

  const result = await ctx.authService.convertGuest(session.userId, validated.data);
  setAuthCookies(res, {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });

  const responseBody: AuthUserResponse = { user: result.user };
  sendJson(req, res, 200, responseBody);
}
