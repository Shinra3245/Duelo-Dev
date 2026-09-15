import type { ConvertGuestRequest, LoginRequest, RegisterRequest } from '@duelodev/shared';
import {
  isRecord,
  validateEmail,
  validateGamertagField,
  validateNonEmptyString,
  validatePassword,
  type ValidationErrorDetail,
  type ValidationResult,
} from './common.js';

/** Esquema formal JSON Schema para RegisterRequest. */
export const registerRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['email', 'password', 'gamertag'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email', maxLength: 255 },
    password: { type: 'string', minLength: 8, maxLength: 128 },
    gamertag: { type: 'string', pattern: '^[A-Za-z0-9-]{3,20}$' },
  },
} as const;

/** Valida en runtime el cuerpo de una petición de registro. */
export function validateRegisterRequest(input: unknown): ValidationResult<RegisterRequest> {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ field: 'body', message: 'El cuerpo de la solicitud debe ser un objeto JSON.' }],
    };
  }

  const errors: ValidationErrorDetail[] = [];

  const emailErr = validateEmail(input['email']);
  if (emailErr) errors.push(emailErr);

  const pwdErr = validatePassword(input['password']);
  if (pwdErr) errors.push(pwdErr);

  const gamertagErr = validateGamertagField(input['gamertag']);
  if (gamertagErr) errors.push(gamertagErr);

  const allowedKeys = new Set(['email', 'password', 'gamertag']);
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
      email: (input['email'] as string).trim().toLowerCase(),
      password: input['password'] as string,
      gamertag: input['gamertag'] as string,
    },
  };
}

/** Esquema formal JSON Schema para LoginRequest. */
export const loginRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email', maxLength: 255 },
    password: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

/** Valida en runtime el cuerpo de una petición de login. */
export function validateLoginRequest(input: unknown): ValidationResult<LoginRequest> {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ field: 'body', message: 'El cuerpo de la solicitud debe ser un objeto JSON.' }],
    };
  }

  const errors: ValidationErrorDetail[] = [];

  const emailErr = validateEmail(input['email']);
  if (emailErr) errors.push(emailErr);

  const pwdErr = validateNonEmptyString(input['password'], 'password', 128);
  if (pwdErr) errors.push(pwdErr);

  const allowedKeys = new Set(['email', 'password']);
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
      email: (input['email'] as string).trim().toLowerCase(),
      password: input['password'] as string,
    },
  };
}

/** Esquema formal JSON Schema para ConvertGuestRequest. */
export const convertGuestRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email', maxLength: 255 },
    password: { type: 'string', minLength: 8, maxLength: 128 },
  },
} as const;

/** Valida en runtime el cuerpo de una petición para convertir un invitado a cuenta registrada. */
export function validateConvertGuestRequest(input: unknown): ValidationResult<ConvertGuestRequest> {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ field: 'body', message: 'El cuerpo de la solicitud debe ser un objeto JSON.' }],
    };
  }

  const errors: ValidationErrorDetail[] = [];

  const emailErr = validateEmail(input['email']);
  if (emailErr) errors.push(emailErr);

  const pwdErr = validatePassword(input['password']);
  if (pwdErr) errors.push(pwdErr);

  const allowedKeys = new Set(['email', 'password']);
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
      email: (input['email'] as string).trim().toLowerCase(),
      password: input['password'] as string,
    },
  };
}
