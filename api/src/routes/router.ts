import type { IncomingMessage, ServerResponse } from 'node:http';
import { ERROR_CODES, ERROR_MESSAGES, type ApiError } from '@duelodev/shared';
import type { ApiContext } from '../types.js';
import { HttpError } from '../plugins/body-parser.js';
import { handleHealthz, handleReadyz } from './health.js';
import {
  handleConvertGuest,
  handleGuest,
  handleLogin,
  handleLogout,
  handleRefresh,
  handleRegister,
  handleMe,
} from './auth.js';
import {
  handleCreateRoom,
  handleGetRoomDetails,
  handleJoinRoom,
  handleStartRoom,
  handleRoomCreationPolicy,
} from './rooms.js';
import {
  handleCreateSubmission,
  handleGetProblemPublic,
  handleGetSubmissionDetails,
} from './submissions.js';
import { handleGetMatchSummary } from './matches.js';
import {
  handleAdminCreateRoom,
  handleAdminCloseAllRooms,
  handleAdminCloseRoom,
  handleAdminPlayers,
  handleAdminRanking,
  handleAdminResult,
  handleAdminRooms,
  handleAdminRoomCreationPolicy,
  handleAdminDeleteRoom,
  handleAdminDeleteRooms,
} from './admin.js';

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

    if (pathname === '/api/v1/auth/register') {
      await handleRegister(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/auth/me') {
      await handleMe(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/auth/login') {
      await handleLogin(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/auth/guest') {
      await handleGuest(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/auth/refresh') {
      await handleRefresh(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/auth/logout') {
      await handleLogout(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/users/convert' || pathname === '/api/v1/auth/convert-guest') {
      await handleConvertGuest(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/rooms') {
      await handleCreateRoom(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/rooms/policy') {
      await handleRoomCreationPolicy(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/admin/rooms') {
      await handleAdminRooms(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/admin/room-policy') {
      await handleAdminRoomCreationPolicy(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/admin/rooms/delete-active') {
      await handleAdminDeleteRooms(req, res, ctx, 'active');
      return;
    }

    if (pathname === '/api/v1/admin/rooms/delete-history') {
      await handleAdminDeleteRooms(req, res, ctx, 'history');
      return;
    }

    if (pathname === '/api/v1/admin/rooms/create') {
      await handleAdminCreateRoom(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/admin/rooms/close-all') {
      await handleAdminCloseAllRooms(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/admin/players') {
      await handleAdminPlayers(req, res, ctx);
      return;
    }

    if (pathname === '/api/v1/admin/ranking') {
      await handleAdminRanking(req, res, ctx);
      return;
    }

    const adminResultMatch = pathname.match(/^\/api\/v1\/admin\/rooms\/([^/]+)\/result$/);
    if (adminResultMatch) {
      await handleAdminResult(req, res, ctx, adminResultMatch[1]!);
      return;
    }

    const adminCloseRoomMatch = pathname.match(/^\/api\/v1\/admin\/rooms\/([^/]+)\/close$/);
    if (adminCloseRoomMatch) {
      await handleAdminCloseRoom(req, res, ctx, adminCloseRoomMatch[1]!);
      return;
    }

    const adminDeleteRoomMatch = pathname.match(/^\/api\/v1\/admin\/rooms\/([^/]+)$/);
    if (adminDeleteRoomMatch && req.method === 'DELETE') {
      await handleAdminDeleteRoom(req, res, ctx, adminDeleteRoomMatch[1]!);
      return;
    }

    const roomJoinMatch = pathname.match(/^\/api\/v1\/rooms\/([^/]+)\/join$/);
    if (roomJoinMatch) {
      const roomCode = roomJoinMatch[1]!;
      await handleJoinRoom(req, res, ctx, roomCode);
      return;
    }

    const roomStartMatch = pathname.match(/^\/api\/v1\/rooms\/([^/]+)\/start$/);
    if (roomStartMatch) {
      const roomCode = roomStartMatch[1]!;
      await handleStartRoom(req, res, ctx, roomCode);
      return;
    }

    const roomDetailsMatch = pathname.match(/^\/api\/v1\/rooms\/([^/]+)$/);
    if (roomDetailsMatch) {
      const roomCode = roomDetailsMatch[1]!;
      await handleGetRoomDetails(req, res, ctx, roomCode);
      return;
    }

    if (pathname === '/api/v1/submissions') {
      await handleCreateSubmission(req, res, ctx, requestId);
      return;
    }

    const submissionDetailsMatch = pathname.match(/^\/api\/v1\/submissions\/([^/]+)$/);
    if (submissionDetailsMatch) {
      const submissionId = submissionDetailsMatch[1]!;
      await handleGetSubmissionDetails(req, res, ctx, submissionId);
      return;
    }

    const problemPublicMatch = pathname.match(/^\/api\/v1\/problems\/([^/]+)\/public$/);
    if (problemPublicMatch) {
      const problemId = problemPublicMatch[1]!;
      await handleGetProblemPublic(req, res, ctx, problemId);
      return;
    }

    const matchSummaryMatch = pathname.match(/^\/api\/v1\/matches\/([^/]+)\/summary$/);
    if (matchSummaryMatch) {
      const matchId = matchSummaryMatch[1]!;
      await handleGetMatchSummary(req, res, ctx, matchId);
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
