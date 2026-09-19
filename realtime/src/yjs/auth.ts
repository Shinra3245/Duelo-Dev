/**
 * Autorización y enrutamiento de conexiones Yjs (doc 04 §79-88).
 *
 * El path lógico es `/yjs/{match_id}/{user_id}`.
 * - Escritura: únicamente el dueño autenticado (`auth.userId === targetUserId`).
 * - Lectura por terceros: requiere membresía en la partida; la interfaz aplica desenfoque visual.
 * - Usuarios que no son miembros de la partida reciben rechazo total (403).
 */

import type { YjsAccessDecision, YjsAuthContext } from './types.js';

const YJS_PATH_REGEX = /^\/yjs\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/?$/;

/**
 * Extrae `matchId` y `targetUserId` de la URL de conexión Yjs.
 * Retorna null si la URL no cumple el patrón `/yjs/{match_id}/{user_id}`.
 */
export function parseYjsPath(pathname: string): { matchId: string; targetUserId: string } | null {
  const match = pathname.match(YJS_PATH_REGEX);
  if (!match || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    matchId: match[1],
    targetUserId: match[2],
  };
}

export interface AuthorizeYjsAccessParams {
  auth: YjsAuthContext;
  matchId: string;
  targetUserId: string;
  isMember: boolean;
}

/**
 * Evalúa los permisos de acceso para una conexión al documento Yjs de un jugador.
 */
export function authorizeYjsAccess(params: AuthorizeYjsAccessParams): YjsAccessDecision {
  const { auth, targetUserId, isMember } = params;

  // 1. Debe ser miembro registrado de la partida
  if (!isMember) {
    return {
      allowed: false,
      canRead: false,
      canWrite: false,
      reason: 'No eres miembro de esta partida.',
    };
  }

  // 2. Dueño del documento: lectura y escritura plenas
  if (auth.userId === targetUserId) {
    return {
      allowed: true,
      canRead: true,
      canWrite: true,
    };
  }

  // 3. Un miembro siempre puede leer para mostrar el código con desenfoque visual.
  return {
    allowed: true,
    canRead: true,
    canWrite: false,
  };
}
