import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeClient } from '../src/lib/realtime.js';

type WebSocketMessageHandler = (event: { data: string }) => void;
type WebSocketCloseHandler = () => void;
type WebSocketOpenHandler = () => void;
type WebSocketErrorHandler = (error: Event) => void;

class MockWebSocket {
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];

  onopen: WebSocketOpenHandler | null = null;
  onmessage: WebSocketMessageHandler | null = null;
  onclose: WebSocketCloseHandler | null = null;
  onerror: WebSocketErrorHandler | null = null;
  readyState = MockWebSocket.OPEN;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  });

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
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
});
