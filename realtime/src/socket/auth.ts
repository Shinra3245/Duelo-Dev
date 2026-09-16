/**
 * Autenticación de handshake WebSocket para el namespace `/match`.
 *
 * Extrae y valida el token de acceso de la solicitud de handshake,
 * ya sea de la cabecera `Authorization: Bearer <token>`, del query
 * string `?token=<token>` o de la cookie `duelodev_access`.
 *
 * No depende de Socket.io directamente: recibe los datos en bruto.
 */

/** Resultado exitoso de autenticación de handshake. */
export interface AuthResult {
  userId: string;
  gamertag: string;
  role: string;
}

/** Cookie parser mínimo para extraer el token de acceso. */
function parseCookie(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match && match[1] !== undefined ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Valida el token JWT/firmado del handshake WebSocket.
 *
 * Estrategia de extracción (en orden de prioridad):
 * 1. `Authorization: Bearer <token>` (cabecera HTTP).
 * 2. `auth.token` del query del handshake.
 * 3. Cookie `duelodev_access`.
 *
 * La validación criptográfica se delega al `tokenVerifier` inyectado,
 * que en producción será `verifyAccessToken` de `@duelodev/shared`.
 *
 * @returns AuthResult si el token es válido; null si ausente, expirado o inválido.
 */
export function authenticateSocketHandshake(
  authHeader: string | undefined,
  authToken: string | undefined,
  cookieHeader: string | undefined,
  tokenVerifier: (token: string) => AuthResult | null,
): AuthResult | null {
  // 1. Bearer token
  let token: string | undefined;

  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const extracted = authHeader.slice(7).trim();
    if (extracted.length > 0) {
      token = extracted;
    }
  }

  // 2. Auth token del handshake query
  if (!token && typeof authToken === 'string' && authToken.length > 0) {
    token = authToken;
  }

  // 3. Cookie duelodev_access
  if (!token && typeof cookieHeader === 'string' && cookieHeader.length > 0) {
    const fromCookie = parseCookie(cookieHeader, 'duelodev_access');
    if (fromCookie && fromCookie.length > 0) {
      token = fromCookie;
    }
  }

  if (!token) {
    return null;
  }

  return tokenVerifier(token);
}
