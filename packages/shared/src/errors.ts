/**
 * Catálogo único de códigos de error de la API (doc 05 §1).
 *
 * `code` es un identificador estable que el cliente puede ramificar.
 * `message` es texto en español apto para mostrar directamente al usuario.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',

  // Autenticación
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  REFRESH_REUSED: 'REFRESH_REUSED',

  // Salas y partidas
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_ALREADY_STARTED: 'ROOM_ALREADY_STARTED',
  ROOM_CREATION_DISABLED: 'ROOM_CREATION_DISABLED',
  GUEST_ROOM_CREATION_FORBIDDEN: 'GUEST_ROOM_CREATION_FORBIDDEN',
  NOT_A_PLAYER: 'NOT_A_PLAYER',
  GAMERTAG_TAKEN: 'GAMERTAG_TAKEN',

  // Envíos
  SUBMIT_COOLDOWN: 'SUBMIT_COOLDOWN',
  SOURCE_TOO_LARGE: 'SOURCE_TOO_LARGE',
  UNSUPPORTED_LANGUAGE: 'UNSUPPORTED_LANGUAGE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Formato único de error de la API. Ninguna respuesta de error usa otra forma. */
export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    request_id?: string;
  };
}

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'Los datos enviados no son válidos.',
  UNAUTHENTICATED: 'Necesitas iniciar sesión.',
  FORBIDDEN: 'No tienes permiso para hacer esto.',
  NOT_FOUND: 'No encontramos lo que buscas.',
  CONFLICT: 'La operación choca con el estado actual.',
  RATE_LIMITED: 'Vas muy rápido. Espera un momento.',
  INTERNAL: 'Algo falló de nuestro lado. Ya lo estamos viendo.',
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos.',
  EMAIL_TAKEN: 'Ese correo ya está registrado.',
  REFRESH_REUSED: 'Tu sesión expiró por seguridad. Inicia sesión de nuevo.',
  ROOM_NOT_FOUND: 'Esa sala no existe o ya terminó.',
  ROOM_FULL: 'La sala está llena.',
  ROOM_ALREADY_STARTED: 'La partida ya empezó.',
  ROOM_CREATION_DISABLED: 'Por el momento no puedes crear partidas, solo unirte con el codigo',
  GUEST_ROOM_CREATION_FORBIDDEN: 'Las cuentas invitadas sólo pueden unirse a salas.',
  NOT_A_PLAYER: 'No eres jugador de esta partida.',
  GAMERTAG_TAKEN: 'Ese gamertag ya está en uso en la sala.',
  SUBMIT_COOLDOWN: 'Espera unos segundos antes de volver a enviar.',
  SOURCE_TOO_LARGE: 'Tu código supera el tamaño máximo permitido.',
  UNSUPPORTED_LANGUAGE: 'Ese lenguaje no está disponible.',
};
