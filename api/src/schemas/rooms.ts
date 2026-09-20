import {
  ACTIVE_PROBLEM_CATEGORIES,
  isMatchConfig,
  type CreateRoomRequest,
  type JoinRoomRequest,
} from '@duelodev/shared';
import {
  isRecord,
  validateGamertagField,
  type ValidationErrorDetail,
  type ValidationResult,
} from './common.js';

const ACTIVE_CATEGORY_SET: ReadonlySet<string> = new Set(ACTIVE_PROBLEM_CATEGORIES);

/** Esquema formal JSON Schema para CreateRoomRequest. */
export const createRoomRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['config'],
  additionalProperties: false,
  properties: {
    config: {
      type: 'object',
      required: ['mode', 'max_players', 'categories', 'num_problems'],
      properties: {
        mode: { type: 'string', enum: ['puntos', 'rondas'] },
        max_players: { type: 'integer', minimum: 2 },
        categories: {
          type: 'array',
          items: { type: 'string', enum: ACTIVE_PROBLEM_CATEGORIES },
          minItems: 1,
        },
        // Puntos
        time_per_problem_s: { type: 'integer', minimum: 1 },
        // Rondas
        match_duration_s: { type: 'integer', minimum: 1 },
        num_problems: { type: 'integer', minimum: 1 },
        target: { type: 'integer', enum: [3, 6, 9, 10] },
      },
    },
  },
} as const;

/** Valida en runtime el cuerpo de una petición de creación de sala. */
export function validateCreateRoomRequest(input: unknown): ValidationResult<CreateRoomRequest> {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ field: 'body', message: 'El cuerpo de la solicitud debe ser un objeto JSON.' }],
    };
  }

  const errors: ValidationErrorDetail[] = [];

  const allowedKeys = new Set(['config']);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      errors.push({
        field: key,
        message: `Propiedad no permitida: '${key}'.`,
        code: 'ADDITIONAL_PROPERTY',
      });
    }
  }

  const config = input['config'];
  if (!isRecord(config)) {
    errors.push({
      field: 'config',
      message: "La propiedad 'config' es obligatoria y debe ser un objeto.",
      code: 'REQUIRED_FIELD',
    });
    return { ok: false, errors };
  }

  // Verificar presencia de propiedad prohibida award_on_timeout
  if ('award_on_timeout' in config) {
    errors.push({
      field: 'config.award_on_timeout',
      message: "La propiedad 'award_on_timeout' fue eliminada del modelo y no está permitida.",
      code: 'FORBIDDEN_PROPERTY',
    });
  }

  if (!isMatchConfig(config)) {
    errors.push({
      field: 'config',
      message: 'La configuración de partida no cumple las invariantes de modo (Puntos/Rondas).',
      code: 'INVALID_CONFIG',
    });
    return { ok: false, errors };
  }

  if (!config.categories.every((category) => ACTIVE_CATEGORY_SET.has(category))) {
    errors.push({
      field: 'config.categories',
      message:
        'Solo se pueden seleccionar las dificultades Junior (Fácil), Semi-senior (Medio) y Senior (Difícil).',
      code: 'INACTIVE_DIFFICULTY',
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      config,
    },
  };
}

/** Esquema formal JSON Schema para JoinRoomRequest. */
export const joinRoomRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['gamertag'],
  additionalProperties: false,
  properties: {
    gamertag: { type: 'string', pattern: '^[A-Za-z0-9-]{3,20}$' },
  },
} as const;

/** Valida en runtime el cuerpo de una petición para unirse a una sala. */
export function validateJoinRoomRequest(input: unknown): ValidationResult<JoinRoomRequest> {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ field: 'body', message: 'El cuerpo de la solicitud debe ser un objeto JSON.' }],
    };
  }

  const errors: ValidationErrorDetail[] = [];

  const gamertagErr = validateGamertagField(input['gamertag']);
  if (gamertagErr) errors.push(gamertagErr);

  const allowedKeys = new Set(['gamertag']);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      errors.push({
        field: key,
        message: `Propiedad no permitida: '${key}'.`,
        code: 'ADDITIONAL_PROPERTY',
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      gamertag: input['gamertag'] as string,
    },
  };
}

/** Expresión regular para el código de sala (6 caracteres alfanuméricos en mayúsculas). */
export const ROOM_CODE_REGEX = /^[A-Z0-9]{4,10}$/;

/** Valida el formato de un código de sala en parámetros de URL. */
export function validateRoomCode(code: unknown, field = 'room_code'): ValidationErrorDetail | null {
  if (typeof code !== 'string') {
    return { field, message: `El parámetro '${field}' debe ser una cadena de texto.` };
  }
  const upper = code.toUpperCase();
  if (!ROOM_CODE_REGEX.test(upper)) {
    return {
      field,
      message: `El parámetro '${field}' debe contener entre 4 y 10 caracteres alfanuméricos.`,
      code: 'INVALID_ROOM_CODE',
    };
  }
  return null;
}
