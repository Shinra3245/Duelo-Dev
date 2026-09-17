type EventHandler = (payload: unknown) => void;

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private isConnecting = false;

  constructor(url: string) {
    this.url = url;
  }

  connect() {
    if (this.ws || this.isConnecting) return;
    this.isConnecting = true;

    // Suponemos que las cookies (auth token) se envían automáticamente al mismo dominio
    // En desarrollo, si es diferente puerto, puede que no se envíen por WebSockets cross-origin
    // a menos que estén en el mismo dominio o se pasen explícitamente, pero el navegador
    // lo maneja si withCredentials no es soportado en ws, ws envía cookies del dominio.
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.isConnecting = false;
      this.emitLocal('connected', null);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.event) {
          this.emitLocal(msg.event, msg.payload);
        }
      } catch (err) {
        console.error('WebSocket message parse error', err);
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.isConnecting = false;
      this.emitLocal('disconnected', null);
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
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
}

export const realtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL || 'ws://localhost:3002/match';
