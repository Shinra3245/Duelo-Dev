/**
 * Adaptador de transporte WebSocket nativo para MatchHub y YjsHub (F3 Unidad 6).
 *
 * Conecta el servidor HTTP nativo con:
 * - `/match`: handshake autenticado, enrutamiento C2S y despacho de eventos S2C vía MatchHub.
 * - `/yjs/{matchId}/{userId}`: handshake autenticado, control de acceso y updates binarios vía YjsHub.
 * - Rechazo 401 Unauthorized para conexiones no autenticadas.
 * - Rechazo 404 Not Found para rutas desconocidas.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  C2S,
  createYjsErrorMessage,
  ERROR_CODES,
  parseYjsClientMessage,
  S2C,
  type Logger,
} from '@duelodev/shared';
import { authenticateSocketHandshake } from '../socket/auth.js';
import type { MatchHub } from '../socket/hub.js';
import type { SocketClient } from '../socket/types.js';
import type { MatchStore } from '../store/types.js';
import { parseYjsPath } from '../yjs/auth.js';
import type { YjsHub } from '../yjs/hub.js';
import type { YjsClientConnection } from '../yjs/types.js';
import { type NativeWebSocket, upgradeToWebSocket } from './websocket.js';

export interface SetupRealtimeUpgradeHandlerOptions {
  server: Server;
  matchHub: MatchHub;
  yjsHub: YjsHub;
  authSecret: string;
  matchStore: MatchStore;
  logger?: Logger | undefined;
}

export interface RealtimeUpgradeController {
  close(): void;
}

function rejectSocket(socket: Duplex, statusCode: number, statusText: string): void {
  const response = `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(statusText)}\r\n\r\n${statusText}`;
  try {
    socket.write(response);
  } finally {
    socket.destroy();
  }
}

function getRemoteAddress(socket: Duplex): string | undefined {
  if (
    'remoteAddress' in socket &&
    typeof (socket as { remoteAddress?: unknown }).remoteAddress === 'string'
  ) {
    return (socket as { remoteAddress: string }).remoteAddress;
  }
  return undefined;
}

/**
 * Registra el manejador de upgrades HTTP para WebSocket en el servidor.
 */
export function setupRealtimeUpgradeHandler(
  options: SetupRealtimeUpgradeHandlerOptions,
): RealtimeUpgradeController {
  const { server, matchHub, yjsHub, authSecret, logger } = options;
  const activeSockets = new Set<NativeWebSocket>();

  const onUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      rejectSocket(socket, 400, 'Bad Request');
      return;
    }

    const pathname = parsedUrl.pathname;
    const queryToken = parsedUrl.searchParams.get('token') ?? undefined;
    const authHeader = req.headers.authorization;
    const cookieHeader = req.headers.cookie;

    // ─────────────────────── Ruta: /match ──────────────────────────────
    if (pathname === '/match') {
      const auth = authenticateSocketHandshake(authHeader, cookieHeader, authSecret, queryToken);
      if (!auth) {
        logger?.warn('Intento de conexión a /match no autorizado', {
          remoteAddress: getRemoteAddress(socket),
        });
        rejectSocket(socket, 401, 'Unauthorized');
        return;
      }

      const ws = upgradeToWebSocket(req, socket, head);
      if (!ws) return;

      activeSockets.add(ws);

      const socketId = `sock-${randomUUID()}`;
      const rooms = new Set<string>();

      const client: SocketClient = {
        id: socketId,
        userId: auth.userId,
        gamertag: auth.gamertag,
        rooms,
        join(room: string): void {
          rooms.add(room);
        },
        leave(room: string): void {
          rooms.delete(room);
        },
        emit(event: string, payload: unknown): void {
          ws.send(JSON.stringify({ event, payload }));
        },
        sendError(code: string, message: string, details?: unknown): void {
          ws.send(
            JSON.stringify({
              event: S2C.ERROR,
              payload: {
                code,
                message,
                details,
                server_time: Date.now(),
              },
            }),
          );
        },
        disconnect(): void {
          ws.close(1000, 'Disconnected by server');
        },
      };

      matchHub.registerClient(client);

      ws.onMessage = (data, isBinary) => {
        if (isBinary) return; // /match opera exclusivamente con mensajes de texto JSON
        try {
          const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
          const msg = JSON.parse(raw) as unknown;
          if (typeof msg !== 'object' || msg === null) return;
          const { event, payload } = msg as { event?: unknown; payload?: unknown };
          if (typeof event !== 'string') return;

          switch (event) {
            case C2S.JOIN_MATCH:
              if (payload && typeof payload === 'object' && 'match_id' in payload) {
                void matchHub.handleJoinMatch(client, payload as { match_id: string });
              } else {
                client.sendError(ERROR_CODES.VALIDATION_FAILED, 'match_id es requerido');
              }
              break;
            case C2S.TOGGLE_REVEAL:
              if (payload && typeof payload === 'object' && 'visible' in payload) {
                void matchHub.handleToggleReveal(client, payload as { visible: boolean });
              } else {
                client.sendError(ERROR_CODES.VALIDATION_FAILED, 'visible es requerido');
              }
              break;
            case C2S.READY:
              void matchHub.handleReady(client);
              break;
            case C2S.HEARTBEAT:
              void matchHub.handleHeartbeat(client);
              break;
            default:
              client.sendError('UNKNOWN_EVENT', `Evento no reconocido: ${event}`);
              break;
          }
        } catch {
          client.sendError(ERROR_CODES.VALIDATION_FAILED, 'Mensaje no es un JSON válido');
        }
      };

      ws.onClose = () => {
        activeSockets.delete(ws);
        void matchHub.handleDisconnect(client);
      };

      return;
    }

    // ─────────────────────── Ruta: /yjs/{matchId}/{userId} ─────────────
    if (pathname.startsWith('/yjs/')) {
      const parsedPath = parseYjsPath(pathname);
      if (!parsedPath) {
        rejectSocket(socket, 404, 'Not Found');
        return;
      }

      const auth = authenticateSocketHandshake(authHeader, cookieHeader, authSecret, queryToken);
      if (!auth) {
        logger?.warn('Intento de conexión a /yjs no autorizado', {
          pathname,
          remoteAddress: getRemoteAddress(socket),
        });
        rejectSocket(socket, 401, 'Unauthorized');
        return;
      }

      const ws = upgradeToWebSocket(req, socket, head);
      if (!ws) return;

      activeSockets.add(ws);

      const clientId = `yjs-${randomUUID()}`;
      const isOwner = auth.userId === parsedPath.targetUserId;

      const clientConn: YjsClientConnection = {
        id: clientId,
        userId: auth.userId,
        matchId: parsedPath.matchId,
        targetUserId: parsedPath.targetUserId,
        isOwner,
        send(data: Uint8Array): void {
          ws.send(data);
        },
        sendText(data: string): void {
          ws.send(data);
        },
        close(code?: number, reason?: string): void {
          ws.close(code, reason);
        },
      };

      const result = await yjsHub.handleConnection(pathname, clientConn, {
        userId: auth.userId,
        gamertag: auth.gamertag,
        role: auth.role,
      });

      if (!result.authorized) {
        activeSockets.delete(ws);
        return;
      }

      let textUpdateChain = Promise.resolve();
      let binaryUpdateChain = Promise.resolve();

      ws.onMessage = (data, isBinary) => {
        if (isBinary) {
          const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
          const gen = result.document?.generation ?? 1;
          binaryUpdateChain = binaryUpdateChain.then(async () => {
            const updateResult = await yjsHub.handleIncomingBinaryUpdate(clientConn, bytes, gen);
            if (!updateResult.applied) {
              ws.send(
                JSON.stringify(
                  createYjsErrorMessage(updateResult.reason ?? 'Actualización rechazada.'),
                ),
              );
            }
          });
          return;
        }

        const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          ws.send(JSON.stringify(createYjsErrorMessage('Mensaje Yjs no es JSON válido.')));
          return;
        }

        const message = parseYjsClientMessage(parsed);
        if (!message) {
          ws.send(
            JSON.stringify(
              createYjsErrorMessage(
                'Actualización inválida: se requiere generación y source_code dentro del límite permitido.',
              ),
            ),
          );
          return;
        }

        textUpdateChain = textUpdateChain.then(async () => {
          const updateResult = await yjsHub.handleIncomingTextUpdate(
            clientConn,
            message.source_code,
            message.generation,
          );
          if (!updateResult.applied) {
            ws.send(
              JSON.stringify(
                createYjsErrorMessage(updateResult.reason ?? 'Actualización rechazada.'),
              ),
            );
          }
        });
      };

      ws.onClose = () => {
        activeSockets.delete(ws);
        yjsHub.removeClient(clientConn);
      };

      return;
    }

    // ─────────────────────── Ruta no reconocida ────────────────────────
    logger?.warn('Ruta WebSocket no encontrada', { pathname });
    rejectSocket(socket, 404, 'Not Found');
  };

  server.on('upgrade', onUpgrade);

  return {
    close(): void {
      server.off('upgrade', onUpgrade);
      for (const ws of activeSockets) {
        try {
          ws.close(1001, 'Server shutting down');
        } catch {
          // Ignorar errores de sockets ya cerrados
        }
      }
      activeSockets.clear();
    },
  };
}
