import { describe, expect, it } from 'vitest';
import {
  createYjsCodeUpdateMessage,
  createYjsErrorMessage,
  createYjsSyncMessage,
  parseYjsClientMessage,
  SOURCE_CODE_MAX_BYTES,
} from '../src/index.js';

describe('protocolo textual Yjs', () => {
  it('acepta actualizaciones Python dentro del límite', () => {
    const message = createYjsCodeUpdateMessage({
      generation: 2,
      source_code: 'print("hola")',
    });

    expect(parseYjsClientMessage(message)).toEqual(message);
  });

  it('rechaza generación inválida y código sobredimensionado', () => {
    expect(parseYjsClientMessage({ type: 'update', generation: 0, source_code: '' })).toBeNull();
    expect(
      parseYjsClientMessage({
        type: 'update',
        generation: 1,
        source_code: 'x'.repeat(SOURCE_CODE_MAX_BYTES + 1),
      }),
    ).toBeNull();
  });

  it('construye mensajes de sincronización y error sin mezclar el contrato de eventos', () => {
    expect(
      createYjsSyncMessage({
        match_id: 'match-1',
        target_user_id: 'user-1',
        round_id: 'round-1',
        generation: 1,
        source_code: '',
      }),
    ).toMatchObject({ type: 'sync', match_id: 'match-1' });
    expect(createYjsErrorMessage('rechazado')).toEqual({ type: 'error', message: 'rechazado' });
  });
});
