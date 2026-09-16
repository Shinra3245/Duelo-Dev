/**
 * Autorización y enrutamiento de conexiones Yjs (doc 04 §79-88).
 *
 * El path lógico es `/yjs/{match_id}/{user_id}`.
 * - Escritura: únicamente el dueño autenticado (`auth.userId === targetUserId`).
 * - Lectura por terceros: requiere membresía en la partida Y (`is_revealed === true` o partida finalizada).
 * - Terceros sin revelado ni partida finalizada reciben rechazo (403).
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
  isRevealed: boolean;
  isFinished: boolean;
}

/**
 * Evalúa los permisos de acceso para una conexión al documento Yjs de un jugador.
 */
export function authorizeYjsAccess(params: AuthorizeYjsAccessParams): YjsAccessDecision {
  const { auth, targetUserId, isMember, isRevealed, isFinished } = params;

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

  // 3. Rival o espectador miembro: solo lectura si está revelado o si la partida finalizó
  if (isRevealed || isFinished) {
    return {
      allowed: true,
      canRead: true,
      canWrite: false, // Rivales nunca pueden escribir en el documento de otro
    };
  }

  // 4. Rival sin revelado y partida activa: denegado para proteger confidencialidad del código
  return {
    allowed: false,
    canRead: false,
    canWrite: false,
    reason: 'El código del rival no ha sido revelado.',
  };
}
