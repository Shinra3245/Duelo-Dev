import { describe, expect, it } from 'vitest';
import { serializeMatchEvent } from '../src/transport/event-budget.js';

describe('presupuesto de eventos WebSocket /match', () => {
  it('serializa mensajes dentro del límite contractual', () => {
    expect(serializeMatchEvent('heartbeat', {})).toBe('{"event":"heartbeat","payload":{}}');
  });

  it('rechaza mensajes cuyo tamaño UTF-8 excede 8 KiB', () => {
    expect(serializeMatchEvent('match_sync', { text: 'x'.repeat(8192) })).toBeNull();
    expect(serializeMatchEvent('match_sync', { text: 'á'.repeat(4096) })).toBeNull();
  });

  it('rechaza payloads que no se pueden serializar', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(serializeMatchEvent('match_sync', circular)).toBeNull();
  });
});
