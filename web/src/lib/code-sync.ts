import {
  createYjsCodeUpdateMessage,
  isYjsCodeUpdateMessage,
  type YjsSyncMessage,
} from '@duelodev/shared';

interface CodeSyncCallbacks {
  onSync: (message: YjsSyncMessage) => void;
  onUpdate: (sourceCode: string) => void;
}

interface CodeSyncMessageRecord {
  type?: unknown;
  match_id?: unknown;
  target_user_id?: unknown;
  round_id?: unknown;
  generation?: unknown;
  source_code?: unknown;
}

/**
 * Cliente pequeño para la proyección textual del documento Yjs del editor.
 * El transporte conserva la autenticación por cookie de la conexión realtime.
 */
export class CodeSyncClient {
  private readonly url: string;
  private readonly callbacks: CodeSyncCallbacks;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private isConnecting = false;
  private generation = 1;
  private pendingCode: string | null = null;

  constructor(
    realtimeMatchUrl: string,
    matchId: string,
    targetUserId: string,
    callbacks: CodeSyncCallbacks,
  ) {
    this.url = buildCodeSyncUrl(realtimeMatchUrl, matchId, targetUserId);
    this.callbacks = callbacks;
  }

  connect(): void {
    if (this.socket || this.isConnecting) return;
    this.shouldReconnect = true;
    this.isConnecting = true;

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.isConnecting = false;
      this.flushPendingCode();
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      this.handleMessage(event.data);
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.isConnecting = false;
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // El cierre posterior activa la reconexión; no mostramos detalles del socket al jugador.
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearFlushTimer();
    const socket = this.socket;
    this.socket = null;
    this.isConnecting = false;
    socket?.close();
  }

  sendCode(sourceCode: string): void {
    this.pendingCode = sourceCode;
    this.scheduleFlush();
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }

    if (isYjsCodeUpdateMessage(parsed)) {
      this.generation = parsed.generation;
      this.callbacks.onUpdate(parsed.source_code);
      return;
    }

    if (!isYjsSyncMessage(parsed)) return;
    this.generation = parsed.generation;
    this.callbacks.onSync(parsed);
    this.flushPendingCode();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPendingCode();
    }, 80);
  }

  private flushPendingCode(): void {
    if (this.pendingCode === null || this.socket?.readyState !== WebSocket.OPEN) return;
    const sourceCode = this.pendingCode;
    this.pendingCode = null;
    this.socket.send(
      JSON.stringify(
        createYjsCodeUpdateMessage({
          generation: this.generation,
          source_code: sourceCode,
        }),
      ),
    );
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === null) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

function isYjsSyncMessage(value: unknown): value is YjsSyncMessage {
  if (!isRecord(value)) return false;
  return (
    value.type === 'sync' &&
    typeof value.match_id === 'string' &&
    typeof value.target_user_id === 'string' &&
    typeof value.round_id === 'string' &&
    typeof value.generation === 'number' &&
    Number.isInteger(value.generation) &&
    value.generation >= 1 &&
    typeof value.source_code === 'string'
  );
}

function isRecord(value: unknown): value is CodeSyncMessageRecord {
  return typeof value === 'object' && value !== null;
}

export function buildCodeSyncUrl(baseRealtimeUrl: string, matchId: string, targetUserId: string) {
  const parsed = new URL(baseRealtimeUrl);
  parsed.pathname = `/yjs/${encodeURIComponent(matchId)}/${encodeURIComponent(targetUserId)}`;
  return parsed.toString();
}
