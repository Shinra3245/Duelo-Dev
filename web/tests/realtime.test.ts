import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeClient, resolveRealtimeUrl } from '../src/lib/realtime.js';
import { buildCodeSyncUrl, CodeSyncClient } from '../src/lib/code-sync.js';

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

  it('alinea alias loopback del WebSocket con el host de la página', () => {
    expect(
      resolveRealtimeUrl('ws://localhost:3002/match', {
        hostname: '127.0.0.1',
        protocol: 'http:',
      }),
    ).toBe('ws://127.0.0.1:3002/match');
  });

  it('usa WSS cuando la página se sirve mediante HTTPS', () => {
    expect(
      resolveRealtimeUrl('ws://localhost:3002/match', {
        hostname: 'duelodev.test',
        protocol: 'https:',
      }),
    ).toBe('wss://duelodev.test:3002/match');
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

  it('construye la ruta Yjs del jugador sin perder el token de transporte', () => {
    const url = new URL(
      buildCodeSyncUrl('ws://test:3002/match?token=transport', 'match 1', 'user/1'),
    );

    expect(url.pathname).toBe('/yjs/match%201/user%2F1');
    expect(url.searchParams.get('token')).toBe('transport');
  });

  it('recibe snapshot y envía actualizaciones textuales del editor', async () => {
    const onSync = vi.fn();
    const onUpdate = vi.fn();
    const client = new CodeSyncClient('ws://test:3002/match', 'match-1', 'user-1', {
      onSync,
      onUpdate,
    });

    client.connect();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const ws = MockWebSocket.instances[0]!;
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'sync',
        match_id: 'match-1',
        target_user_id: 'user-1',
        round_id: 'round-1',
        generation: 1,
        source_code: '',
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({ type: 'update', generation: 1, source_code: 'x = 1' }),
    });
    client.sendCode('print(1)');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(onSync).toHaveBeenCalledWith(expect.objectContaining({ type: 'sync' }));
    expect(onUpdate).toHaveBeenCalledWith('x = 1');
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'update', generation: 1, source_code: 'print(1)' }),
    );
    client.disconnect();
  });
});
