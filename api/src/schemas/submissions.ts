import {
  isLanguage,
  LANGUAGES,
  SOURCE_CODE_MAX_BYTES,
  type CreateSubmissionRequest,
  type Language,
} from '@duelodev/shared';
import {
  isRecord,
  validateNonEmptyString,
  type ValidationErrorDetail,
  type ValidationResult,
} from './common.js';

/** Esquema formal JSON Schema para CreateSubmissionRequest. */
export const createSubmissionRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['match_id', 'round_id', 'problem_id', 'language', 'source_code'],
  additionalProperties: false,
  properties: {
    match_id: { type: 'string', minLength: 1, maxLength: 64 },
    round_id: { type: 'string', minLength: 1, maxLength: 64 },
    problem_id: { type: 'string', minLength: 1, maxLength: 64 },
    language: { type: 'string', enum: LANGUAGES },
    source_code: { type: 'string', minLength: 1, maxLength: SOURCE_CODE_MAX_BYTES },
  },
} as const;

/** Valida en runtime el cuerpo de una petición de envío de solución. */
export function validateCreateSubmissionRequest(
  input: unknown,
): ValidationResult<CreateSubmissionRequest> {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [{ field: 'body', message: 'El cuerpo de la solicitud debe ser un objeto JSON.' }],
    };
  }

  const errors: ValidationErrorDetail[] = [];

  const matchErr = validateNonEmptyString(input['match_id'], 'match_id', 64);
  if (matchErr) errors.push(matchErr);

  const roundErr = validateNonEmptyString(input['round_id'], 'round_id', 64);
  if (roundErr) errors.push(roundErr);

  const problemErr = validateNonEmptyString(input['problem_id'], 'problem_id', 64);
  if (problemErr) errors.push(problemErr);

  const lang = input['language'];
  if (!isLanguage(lang)) {
    errors.push({
      field: 'language',
      message: `El lenguaje '${String(lang)}' no está disponible. Valores soportados: ${LANGUAGES.join(', ')}.`,
      code: 'UNSUPPORTED_LANGUAGE',
    });
  }

  const sourceCode = input['source_code'];
  if (typeof sourceCode !== 'string') {
    errors.push({
      field: 'source_code',
      message: "El campo 'source_code' debe ser una cadena de texto.",
    });
  } else if (sourceCode.trim().length === 0) {
    errors.push({
      field: 'source_code',
      message: "El código fuente ('source_code') no puede estar vacío.",
      code: 'EMPTY_SOURCE_CODE',
    });
  } else {
    const byteLength = Buffer.byteLength(sourceCode, 'utf8');
    if (byteLength > SOURCE_CODE_MAX_BYTES) {
      errors.push({
        field: 'source_code',
        message: `El código fuente supera el límite máximo de ${SOURCE_CODE_MAX_BYTES} bytes (${byteLength} bytes recibidos).`,
        code: 'SOURCE_TOO_LARGE',
      });
    }
  }

  const allowedKeys = new Set(['match_id', 'round_id', 'problem_id', 'language', 'source_code']);
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
      match_id: input['match_id'] as string,
      round_id: input['round_id'] as string,
      problem_id: input['problem_id'] as string,
      language: input['language'] as Language,
      source_code: input['source_code'] as string,
    },
  };
}
