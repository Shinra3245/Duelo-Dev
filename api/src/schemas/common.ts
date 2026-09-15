import { isValidGamertag } from '@duelodev/shared';

/** Detalle de un error de validación de campo en runtime. */
export interface ValidationErrorDetail {
  field: string;
  message: string;
  code?: string;
}

export interface ValidationSuccess<T> {
  ok: true;
  data: T;
}

export interface ValidationFailure {
  ok: false;
  errors: ValidationErrorDetail[];
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

/** Verifica si un valor desconocido es un objeto JSON plano no nulo. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Valida una dirección de correo electrónico estándar. */
export function validateEmail(value: unknown, field = 'email'): ValidationErrorDetail | null {
  if (typeof value !== 'string') {
    return { field, message: `El campo '${field}' debe ser una cadena de texto.` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { field, message: `El campo '${field}' no puede estar vacío.` };
  }
  // Expresión regular estándar para correos
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmed) || trimmed.length > 255) {
    return {
      field,
      message: `El campo '${field}' debe ser una dirección de correo válida.`,
      code: 'INVALID_EMAIL',
    };
  }
  return null;
}

/** Valida un gamertag según la expresión regular canónica (doc 04 §2). */
export function validateGamertagField(
  value: unknown,
  field = 'gamertag',
): ValidationErrorDetail | null {
  if (typeof value !== 'string') {
    return { field, message: `El campo '${field}' debe ser una cadena de texto.` };
  }
  if (!isValidGamertag(value)) {
    return {
      field,
      message: `El campo '${field}' debe tener entre 3 y 20 caracteres alfanuméricos o guiones (^[A-Za-z0-9-]{3,20}$).`,
      code: 'INVALID_GAMERTAG',
    };
  }
  return null;
}

/** Valida una contraseña con longitud mínima y máxima segura. */
export function validatePassword(
  value: unknown,
  field = 'password',
  minLength = 8,
  maxLength = 128,
): ValidationErrorDetail | null {
  if (typeof value !== 'string') {
    return { field, message: `El campo '${field}' debe ser una cadena de texto.` };
  }
  if (value.length < minLength) {
    return {
      field,
      message: `El campo '${field}' debe contener al menos ${minLength} caracteres.`,
      code: 'PASSWORD_TOO_SHORT',
    };
  }
  if (value.length > maxLength) {
    return {
      field,
      message: `El campo '${field}' no puede exceder ${maxLength} caracteres.`,
      code: 'PASSWORD_TOO_LONG',
    };
  }
  return null;
}

/** Valida una cadena de texto no vacía. */
export function validateNonEmptyString(
  value: unknown,
  field: string,
  maxLength?: number,
): ValidationErrorDetail | null {
  if (typeof value !== 'string') {
    return { field, message: `El campo '${field}' debe ser una cadena de texto.` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { field, message: `El campo '${field}' no puede estar vacío.` };
  }
  if (maxLength !== undefined && value.length > maxLength) {
    return {
      field,
      message: `El campo '${field}' no puede superar ${maxLength} caracteres.`,
      code: 'STRING_TOO_LONG',
    };
  }
  return null;
}
