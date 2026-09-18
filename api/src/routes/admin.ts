import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  isMatchStatus,
  type ActiveProblemCategory,
  type AdminManualResultRequest,
  type AdminPlayersResponse,
  type AdminRankingResponse,
  type AdminRoomsResponse,
} from '@duelodev/shared';
import { HttpError, parseJsonBody } from '../plugins/body-parser.js';
import { validateCreateRoomRequest } from '../schemas/rooms.js';
import { isRecord } from '../schemas/common.js';
import { ADMIN_ALLOWED_EMAIL } from '../services/admin.js';
import type { ApiContext } from '../types.js';
import { extractAccessToken } from './auth.js';
import { sendJson } from './router.js';

function requireAdmin(req: IncomingMessage, ctx: ApiContext): Promise<{ id: string }> {
  const rawToken = extractAccessToken(req);
  if (!rawToken) {
    throw new HttpError(401, ERROR_CODES.UNAUTHENTICATED, ERROR_MESSAGES.UNAUTHENTICATED);
  }

  const session = ctx.authService.authenticateAccessToken(rawToken);
  if (session.role !== 'admin') {
    throw new HttpError(403, ERROR_CODES.FORBIDDEN, ERROR_MESSAGES.FORBIDDEN);
  }

  return ctx.userRepo.findById(session.userId).then((user) => {
    if (user?.role !== 'admin' || user.email?.toLowerCase() !== ADMIN_ALLOWED_EMAIL) {
      throw new HttpError(403, ERROR_CODES.FORBIDDEN, ERROR_MESSAGES.FORBIDDEN);
    }
    return { id: user.id };
  });
}

function getPage(req: IncomingMessage): { limit: number; offset: number; query: URLSearchParams } {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parsedLimit = Number(url.searchParams.get('limit') ?? 50);
  const parsedOffset = Number(url.searchParams.get('offset') ?? 0);
  return {
    limit: Number.isInteger(parsedLimit) ? Math.max(1, Math.min(100, parsedLimit)) : 50,
    offset: Number.isInteger(parsedOffset) ? Math.max(0, Math.min(100_000, parsedOffset)) : 0,
    query: url.searchParams,
  };
}

function validateManualResultRequest(
  input: unknown,
): { ok: true; data: AdminManualResultRequest } | { ok: false } {
  if (!isRecord(input) || !Array.isArray(input['winner_ids'])) return { ok: false };
  const winnerIds = input['winner_ids'];
  if (
    winnerIds.length > 3 ||
    !winnerIds.every((id): id is string => typeof id === 'string' && id.length > 0)
  ) {
    return { ok: false };
  }
  return { ok: true, data: { winner_ids: [...new Set(winnerIds)] } };
}

function ensureMethod(req: IncomingMessage, res: ServerResponse, method: string): void {
  if (req.method !== method) {
    res.setHeader('Allow', method);
    throw new HttpError(405, ERROR_CODES.VALIDATION_FAILED, `Método no permitido. Use ${method}.`);
  }
}

export async function handleAdminCreateRoom(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  ensureMethod(req, res, 'POST');
  const admin = await requireAdmin(req, ctx);
  const body = await parseJsonBody(req);
  const validated = validateCreateRoomRequest(body);
  if (
    !validated.ok ||
    validated.data.config.max_players > 3 ||
    !validated.data.config.categories.every(
      (category): category is ActiveProblemCategory => category !== 'dificil',
    )
  ) {
    throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, ERROR_MESSAGES.VALIDATION_FAILED, {
      errors: [
        {
          field: 'config',
          message: 'Una sala debe admitir 2 o 3 jugadores y usar dificultades activas.',
        },
      ],
    });
  }

  const hostHeader = req.headers['host'] ?? 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto']
    ? String(req.headers['x-forwarded-proto'])
    : 'http';
  const result = await ctx.roomService.createRoom(
    admin.id,
    validated.data,
    `${protocol}://${hostHeader}`,
  );
  sendJson(req, res, 201, result);
}

export async function handleAdminRooms(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  ensureMethod(req, res, 'GET');
  await requireAdmin(req, ctx);
  const page = getPage(req);
  const rawStatus = page.query.get('status');
  if (rawStatus && !isMatchStatus(rawStatus)) {
    throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, ERROR_MESSAGES.VALIDATION_FAILED);
  }
  const status = rawStatus && isMatchStatus(rawStatus) ? rawStatus : undefined;
  const body: AdminRoomsResponse = {
    rooms: await ctx.adminService.listRooms({
      limit: page.limit,
      offset: page.offset,
      ...(status ? { status } : {}),
    }),
    limit: page.limit,
    offset: page.offset,
  };
  sendJson(req, res, 200, body);
}

export async function handleAdminPlayers(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  ensureMethod(req, res, 'GET');
  await requireAdmin(req, ctx);
  const page = getPage(req);
  const query = page.query.get('q');
  const body: AdminPlayersResponse = {
    players: await ctx.adminService.listPlayers({
      limit: page.limit,
      offset: page.offset,
      ...(query ? { query } : {}),
    }),
    limit: page.limit,
    offset: page.offset,
  };
  sendJson(req, res, 200, body);
}

export async function handleAdminRanking(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  ensureMethod(req, res, 'GET');
  await requireAdmin(req, ctx);
  const body: AdminRankingResponse = { ranking: await ctx.adminService.ranking() };
  sendJson(req, res, 200, body);
}

export async function handleAdminResult(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  matchId: string,
): Promise<void> {
  ensureMethod(req, res, 'POST');
  const admin = await requireAdmin(req, ctx);
  const validated = validateManualResultRequest(await parseJsonBody(req));
  if (!validated.ok) {
    throw new HttpError(400, ERROR_CODES.VALIDATION_FAILED, ERROR_MESSAGES.VALIDATION_FAILED);
  }
  const room = await ctx.adminService.overrideResult(matchId, validated.data.winner_ids, admin.id);
  sendJson(req, res, 200, { room, audited: true });
}
