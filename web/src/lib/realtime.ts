import { alignLoopbackServiceHost, type BrowserLocation } from './browser-service-url';

type EventHandler = (payload: unknown) => void;

interface RealtimeClientOptions {
  reconnectDelayMs?: number;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private isConnecting = false;
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;

  constructor(url: string, options: RealtimeClientOptions = {}) {
    this.url = url;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  }

  connect() {
    if (this.ws || this.isConnecting) return;
    this.shouldReconnect = true;
    this.clearReconnectTimer();
    this.isConnecting = true;

    // Suponemos que las cookies (auth token) se envían automáticamente al mismo dominio
    // En desarrollo, si es diferente puerto, puede que no se envíen por WebSockets cross-origin
    // a menos que estén en el mismo dominio o se pasen explícitamente, pero el navegador
    // lo maneja si withCredentials no es soportado en ws, ws envía cookies del dominio.
    const socket = new WebSocket(this.url);
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.isConnecting = false;
      this.emitLocal('connected', null);
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.event) {
          this.emitLocal(msg.event, msg.payload);
        }
      } catch (err) {
        console.error('WebSocket message parse error', err);
      }
    };

    socket.onclose = () => {
      if (this.ws === socket) {
        this.ws = null;
      }
      this.isConnecting = false;
      this.emitLocal('disconnected', null);
      this.scheduleReconnect();
    };

    socket.onerror = (err) => {
      if (this.ws !== socket) return;
      console.error('WebSocket error:', err);
    };
  }

  disconnect() {
    this.shouldReconnect = false;
    this.clearReconnectTimer();

    const socket = this.ws;
    this.ws = null;
    this.isConnecting = false;
    socket?.close();
  }

  send(event: string, payload?: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event, payload }));
    }
  }

  on(event: string, handler: EventHandler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler) {
    this.handlers.get(event)?.delete(handler);
  }

  private emitLocal(event: string, payload: unknown) {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      eventHandlers.forEach((h) => h(payload));
    }
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

const DEFAULT_REALTIME_URL = 'ws://localhost:3002/match';

export const realtimeUrl = resolveRealtimeUrl();

export function resolveRealtimeUrl(
  configuredUrl = process.env.NEXT_PUBLIC_REALTIME_URL || DEFAULT_REALTIME_URL,
  browserLocation: BrowserLocation | null = typeof window === 'undefined' ? null : window.location,
) {
  if (!browserLocation) {
    return configuredUrl;
  }

  try {
    const socketProtocol = browserLocation.protocol === 'https:' ? 'wss:' : 'ws:';
    return alignLoopbackServiceHost(configuredUrl, browserLocation, socketProtocol);
  } catch {
    const protocol = browserLocation.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${browserLocation.hostname}:3002/match`;
  }
}
