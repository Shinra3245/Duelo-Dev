import { SOURCE_CODE_MAX_BYTES } from './limits.js';

export const YJS_MESSAGE_TYPES = {
  SYNC: 'sync',
  UPDATE: 'update',
  ERROR: 'error',
} as const;

export interface YjsCodeUpdateMessage {
  type: typeof YJS_MESSAGE_TYPES.UPDATE;
  generation: number;
  source_code: string;
}

export interface YjsSyncMessage {
  type: typeof YJS_MESSAGE_TYPES.SYNC;
  match_id: string;
  target_user_id: string;
  round_id: string;
  generation: number;
  source_code: string;
}

export interface YjsErrorMessage {
  type: typeof YJS_MESSAGE_TYPES.ERROR;
  message: string;
}

export type YjsServerMessage = YjsSyncMessage | YjsCodeUpdateMessage | YjsErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasValidGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function sourceCodeFitsLimit(sourceCode: string): boolean {
  return new TextEncoder().encode(sourceCode).byteLength <= SOURCE_CODE_MAX_BYTES;
}

/** Valida mensajes JSON recibidos por el canal de sincronización de código. */
export function parseYjsClientMessage(value: unknown): YjsCodeUpdateMessage | null {
  if (!isRecord(value)) return null;
  if (value.type !== YJS_MESSAGE_TYPES.UPDATE) return null;
  if (!hasValidGeneration(value.generation)) return null;
  if (typeof value.source_code !== 'string' || !sourceCodeFitsLimit(value.source_code)) {
    return null;
  }
  return {
    type: YJS_MESSAGE_TYPES.UPDATE,
    generation: value.generation,
    source_code: value.source_code,
  };
}

export function isYjsCodeUpdateMessage(value: unknown): value is YjsCodeUpdateMessage {
  return parseYjsClientMessage(value) !== null;
}

export function createYjsSyncMessage(input: Omit<YjsSyncMessage, 'type'>): YjsSyncMessage {
  return { type: YJS_MESSAGE_TYPES.SYNC, ...input };
}

export function createYjsCodeUpdateMessage(
  input: Omit<YjsCodeUpdateMessage, 'type'>,
): YjsCodeUpdateMessage {
  return { type: YJS_MESSAGE_TYPES.UPDATE, ...input };
}

export function createYjsErrorMessage(message: string): YjsErrorMessage {
  return { type: YJS_MESSAGE_TYPES.ERROR, message };
}
