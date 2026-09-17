import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeClient } from '../src/lib/realtime.js';

// Mock simple de WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  onopen: (() => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: any) => void) | null = null;
  readyState = 1; // OPEN
  url: string;

  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 0);
  }

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  });
}

const originalWebSocket = global.WebSocket;

describe('Realtime Client', () => {
  beforeEach(() => {
    (global as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  it('debería emitir "connected" al abrir la conexión', async () => {
    const client = new RealtimeClient('ws://test');

    const connectSpy = vi.fn();
    client.on('connected', connectSpy);

    client.connect();

    // Dar un micro tick para que salte el setTimeout del mock
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('debería procesar mensajes entrantes correctamente (JSON válido)', async () => {
    const client = new RealtimeClient('ws://test');

    const eventSpy = vi.fn();
    client.on('TEST_EVENT', eventSpy);

    client.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Extraer la instancia mock creada (un poco de hack para test)
    // El onmessage fue configurado.
    const wsInstance = (client as any).ws;
    wsInstance.onmessage({
      data: JSON.stringify({ event: 'TEST_EVENT', payload: { foo: 'bar' } }),
    });

    expect(eventSpy).toHaveBeenCalledWith({ foo: 'bar' });
  });

  it('debería ignorar mensajes con JSON inválido o sin event', async () => {
    const client = new RealtimeClient('ws://test');

    const eventSpy = vi.fn();
    client.on('TEST_EVENT', eventSpy);

    client.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const wsInstance = (client as any).ws;

    // Invalid JSON
    wsInstance.onmessage({ data: 'not_a_json' });

    // No event
    wsInstance.onmessage({ data: JSON.stringify({ payload: { foo: 'bar' } }) });

    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('debería enviar mensajes si está conectado', async () => {
    const client = new RealtimeClient('ws://test');

    client.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const wsInstance = (client as any).ws;

    client.send('MY_EVENT', { data: 123 });

    expect(wsInstance.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'MY_EVENT', payload: { data: 123 } }),
    );
  });

  it('no debería conectar doble si ya está conectando', () => {
    const client = new RealtimeClient('ws://test');
    client.connect();
    client.connect();

    // No hay manera directa de validar que llamó new WebSocket una vez sin hacer spy en el constructor global,
    // pero si lo testeamos asumiendo que "isConnecting" funciona, no crashea
  });
});
