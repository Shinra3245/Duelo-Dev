import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeClient } from '../src/lib/realtime.js';

type WebSocketMessageHandler = (event: { data: string }) => void;
type WebSocketCloseHandler = () => void;
type WebSocketOpenHandler = () => void;
type WebSocketErrorHandler = (error: Event) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  onopen: WebSocketOpenHandler | null = null;
  onmessage: WebSocketMessageHandler | null = null;
  onclose: WebSocketCloseHandler | null = null;
  onerror: WebSocketErrorHandler | null = null;
  readyState = MockWebSocket.CONNECTING;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  });

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }
}

const originalWebSocket = global.WebSocket;

describe('Realtime Client', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  it('emite "connected" al abrir la conexión', async () => {
    const client = new RealtimeClient('ws://test');
    const connectSpy = vi.fn();

    client.on('connected', connectSpy);
    client.connect();

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('procesa mensajes entrantes con JSON válido', async () => {
    const client = new RealtimeClient('ws://test');
    const eventSpy = vi.fn();

    client.on('TEST_EVENT', eventSpy);
    client.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));

    MockWebSocket.instances[0]!.onmessage?.({
      data: JSON.stringify({ event: 'TEST_EVENT', payload: { foo: 'bar' } }),
    });

    expect(eventSpy).toHaveBeenCalledWith({ foo: 'bar' });
  });

  it('ignora mensajes con JSON inválido o sin event', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new RealtimeClient('ws://test');
    const eventSpy = vi.fn();

    client.on('TEST_EVENT', eventSpy);
    client.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const ws = MockWebSocket.instances[0]!;
    ws.onmessage?.({ data: 'not_a_json' });
    ws.onmessage?.({ data: JSON.stringify({ payload: { foo: 'bar' } }) });

    expect(eventSpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it('envía mensajes si está conectado', async () => {
    const client = new RealtimeClient('ws://test');

    client.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const ws = MockWebSocket.instances[0]!;
    client.send('MY_EVENT', { data: 123 });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'MY_EVENT', payload: { data: 123 } }),
    );
  });

  it('no abre una segunda conexión si ya se está conectando', () => {
    const client = new RealtimeClient('ws://test');

    client.connect();
    client.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('reconecta automáticamente después de un cierre inesperado', async () => {
    const client = new RealtimeClient('ws://test', { reconnectDelayMs: 5 });
    const disconnectSpy = vi.fn();

    client.on('disconnected', disconnectSpy);
    client.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));

    MockWebSocket.instances[0]!.onclose?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('no reconecta después de una desconexión manual', async () => {
    const client = new RealtimeClient('ws://test', { reconnectDelayMs: 5 });

    client.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const ws = MockWebSocket.instances[0]!;
    client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
