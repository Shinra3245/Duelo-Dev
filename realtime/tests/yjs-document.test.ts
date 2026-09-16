import { describe, expect, it } from 'vitest';
import { MAX_YDOC_BYTES } from '@duelodev/shared';
import { YjsDocument } from '../src/yjs/document.js';
import type { YjsClientConnection } from '../src/yjs/types.js';

function createMockObserver(id: string): {
  client: YjsClientConnection;
  receivedUpdates: Uint8Array[];
} {
  const receivedUpdates: Uint8Array[] = [];
  const client: YjsClientConnection = {
    id,
    userId: 'user-observer',
    matchId: 'match-1',
    targetUserId: 'user-target',
    isOwner: false,
    send(data: Uint8Array) {
      receivedUpdates.push(data);
    },
    close() {},
  };
  return { client, receivedUpdates };
}

describe('YjsDocument', () => {
  it('inicializa con generación 1 y código inicial opcional', () => {
    const doc = new YjsDocument({
      matchId: 'match-1',
      userId: 'user-1',
      roundId: 'round-1',
      initialCode: 'function solution() {}',
    });

    expect(doc.generation).toBe(1);
    expect(doc.matchId).toBe('match-1');
    expect(doc.userId).toBe('user-1');
    expect(doc.roundId).toBe('round-1');
    expect(doc.getText()).toBe('function solution() {}');
    expect(doc.isFrozen).toBe(false);
    expect(doc.currentBytes).toBeGreaterThan(0);
  });

  it('aplica actualizaciones binarias y difunde a los observadores', () => {
    const doc = new YjsDocument({
      matchId: 'match-1',
      userId: 'user-1',
      roundId: 'round-1',
    });

    const obs1 = createMockObserver('obs-1');
    const obs2 = createMockObserver('obs-2');
    doc.addObserver(obs1.client);
    doc.addObserver(obs2.client);
    expect(doc.observerCount).toBe(2);

    const update = new Uint8Array([1, 2, 3, 4]);
    const res = doc.applyUpdate(update, 1, 'const a = 10;', 'author-client');

    expect(res.applied).toBe(true);
    expect(doc.getText()).toBe('const a = 10;');
    expect(obs1.receivedUpdates).toHaveLength(1);
    expect(obs2.receivedUpdates).toHaveLength(1);
  });

  it('no re-envía la actualización al cliente autor de la misma', () => {
    const doc = new YjsDocument({
      matchId: 'match-1',
      userId: 'user-1',
      roundId: 'round-1',
    });

    const author = createMockObserver('author-client');
    const rival = createMockObserver('rival-client');
    doc.addObserver(author.client);
    doc.addObserver(rival.client);

    const update = new Uint8Array([10, 20]);
    doc.applyUpdate(update, 1, 'code', 'author-client');

    expect(author.receivedUpdates).toHaveLength(0); // Excluido
    expect(rival.receivedUpdates).toHaveLength(1); // Notificado
  });

  it('rechaza actualizaciones pertenecientes a generaciones obsoletas (doc 04 §80-82)', () => {
    const doc = new YjsDocument({
      matchId: 'match-1',
      userId: 'user-1',
      roundId: 'round-2',
      generation: 2,
    });

    const update = new Uint8Array([1, 2]);
    const res = doc.applyUpdate(update, 1); // Generación 1 enviada a documento de gen 2

    expect(res.applied).toBe(false);
    expect(res.reason).toContain('Generación desfasada');
  });

  it('rechaza actualizaciones si el documento ha sido congelado', () => {
    const doc = new YjsDocument({
      matchId: 'match-1',
      userId: 'user-1',
      roundId: 'round-1',
    });

    doc.freeze();
    expect(doc.isFrozen).toBe(true);

    const update = new Uint8Array([1, 2]);
    const res = doc.applyUpdate(update, 1);

    expect(res.applied).toBe(false);
    expect(res.reason).toContain('congelado');
  });

  it('rechaza actualizaciones que excedan el límite de 256 KiB (invariante H12)', () => {
    const doc = new YjsDocument({
      matchId: 'match-1',
      userId: 'user-1',
      roundId: 'round-1',
      maxBytes: 100, // Límite reducido para la prueba
    });

    // Update de 101 bytes (excede 100 bytes)
    const largeUpdate = new Uint8Array(101);
    const res = doc.applyUpdate(largeUpdate, 1);

    expect(res.applied).toBe(false);
    expect(res.reason).toContain('Límite de documento excedido');
  });

  it('respeta MAX_YDOC_BYTES de @duelodev/shared por defecto', () => {
    const doc = new YjsDocument({
      matchId: 'match-1',
      userId: 'user-1',
      roundId: 'round-1',
    });

    // Límite es 256 KiB
    const safeUpdate = new Uint8Array(200 * 1024); // 200 KiB
    expect(doc.applyUpdate(safeUpdate, 1).applied).toBe(true);

    // Otro de 60 KiB llevaría a 260 KiB (> 256 KiB = 262144 B)
    const exceedingUpdate = new Uint8Array(60 * 1024);
    const res = doc.applyUpdate(exceedingUpdate, 1);
    expect(res.applied).toBe(false);
    expect(res.reason).toContain(String(MAX_YDOC_BYTES));
  });

  it('captura snapshots inmutables con metadata correcta', () => {
    const doc = new YjsDocument({
      matchId: 'match-1',
      userId: 'user-1',
      roundId: 'round-1',
      initialCode: 'initial code',
    });

    const snapshot = doc.captureSnapshot(true);

    expect(snapshot.matchId).toBe('match-1');
    expect(snapshot.userId).toBe('user-1');
    expect(snapshot.roundId).toBe('round-1');
    expect(snapshot.generation).toBe(1);
    expect(snapshot.code).toBe('initial code');
    expect(snapshot.isRevealed).toBe(true);
    expect(new Date(snapshot.capturedAt).getTime()).toBeGreaterThan(0);
  });
});
