/**
 * Implementación de transporte WebSocket nativo RFC 6455 (Decisión A2).
 *
 * CERO dependencias externas nuevas: implementado sobre `node:http`, `node:crypto` y `node:stream`.
 * Soporta:
 * - Handshake HTTP 101 Switching Protocols.
 * - Validación y cálculo de `Sec-WebSocket-Accept`.
 * - Parseo de frames entrantes enmascarados (RFC 6455 §5.1 / §5.2).
 * - Encodificación de frames salientes no enmascarados (servidor a cliente).
 * - Opcodes: 0x1 (texto), 0x2 (binario), 0x8 (close), 0x9 (ping), 0xA (pong).
 * - Manejo de chunks fragmentados a nivel de socket TCP.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export class NativeWebSocket {
  public readyState: number = READY_STATE.OPEN;
  public onMessage: ((data: string | Uint8Array, isBinary: boolean) => void) | null = null;
  public onClose: ((code: number, reason: string) => void) | null = null;
  public onError: ((err: Error) => void) | null = null;

  private buffer: Buffer = Buffer.alloc(0);
  private fragmentBuffers: Buffer[] = [];
  private fragmentOpcode: number = 0;
  private isClosed: boolean = false;
  private closeCode: number = 1000;
  private closeReason: string = '';
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public readonly socket: Duplex,
    initialHead?: Buffer,
  ) {
    if (initialHead && initialHead.length > 0) {
      this.buffer = Buffer.from(initialHead);
    }

    this.socket.on('data', (chunk: Buffer) => {
      this.handleData(chunk);
    });

    this.socket.on('error', (err: Error) => {
      if ((err as { code?: string }).code === 'ABORT_ERR') {
        return;
      }
      if (this.onError) {
        this.onError(err);
      }
      this.cleanup(1006, 'Socket error');
    });

    this.socket.on('close', () => {
      this.cleanup(this.closeCode, this.closeReason);
    });

    this.socket.on('end', () => {
      this.cleanup(this.closeCode, this.closeReason);
    });

    // Procesar cualquier dato inicial de head
    if (this.buffer.length > 0) {
      this.processBuffer();
    }
  }

  /**
   * Envía datos (texto UTF-8 o binario Uint8Array/Buffer) en un frame WebSocket no enmascarado.
   */
  send(data: string | Uint8Array): void {
    if (this.readyState !== READY_STATE.OPEN) {
      return;
    }

    const isBinary = typeof data !== 'string';
    const opcode = isBinary ? OPCODES.BINARY : OPCODES.TEXT;
    const frame = encodeFrame(opcode, data);
    this.socket.write(frame);
  }

  /**
   * Envía un frame de Ping (0x9).
   */
  ping(data?: Buffer | Uint8Array): void {
    if (this.readyState !== READY_STATE.OPEN) return;
    const frame = encodeFrame(OPCODES.PING, data ?? Buffer.alloc(0));
    this.socket.write(frame);
  }

  /**
   * Envía un frame de Pong (0xA).
   */
  pong(data?: Buffer | Uint8Array): void {
    if (this.readyState !== READY_STATE.OPEN) return;
    const frame = encodeFrame(OPCODES.PONG, data ?? Buffer.alloc(0));
    this.socket.write(frame);
  }

  /**
   * Cierra ordenadamente la conexión WebSocket con código de estado y razón.
   */
  close(code: number = 1000, reason: string = ''): void {
    if (this.readyState === READY_STATE.CLOSED || this.readyState === READY_STATE.CLOSING) {
      return;
    }

    this.readyState = READY_STATE.CLOSING;
    this.closeCode = code;
    this.closeReason = reason;

    // Construir payload de cierre: 2 bytes de código + razón en UTF-8
    const reasonBuf = Buffer.from(reason, 'utf8');
    const closePayload = Buffer.allocUnsafe(2 + reasonBuf.length);
    closePayload.writeUInt16BE(code, 0);
    reasonBuf.copy(closePayload, 2);

    const frame = encodeFrame(OPCODES.CLOSE, closePayload);
    this.socket.write(frame, () => {
      try {
        this.socket.end();
      } catch {
        // Ignorar
      }
      this.cleanup(code, reason);
    });

    // Timeout de seguridad si el peer no cierra el socket TCP
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
    }
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (this.readyState !== READY_STATE.CLOSED) {
        this.cleanup(code, reason);
        try {
          this.socket.destroy();
        } catch {
          // Ignorar
        }
      }
    }, 500);
    if (this.closeTimer && typeof this.closeTimer.unref === 'function') {
      this.closeTimer.unref();
    }
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.buffer.length >= 2) {
      const byte0 = this.buffer[0]!;
      const byte1 = this.buffer[1]!;

      const fin = (byte0 & 0x80) !== 0;
      const rsv = byte0 & 0x70;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;

      // RFC 6455 §5.2: si RSV no negociado no es 0, protocolo error
      if (rsv !== 0) {
        this.close(1002, 'RSV must be 0');
        return;
      }

      // RFC 6455 §5.1: frames del cliente DEBEN estar enmascarados
      if (!masked) {
        this.close(1002, 'Client frames must be masked');
        return;
      }

      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLen = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (this.buffer.length < offset + 8) return;
        const bigLen = this.buffer.readBigUInt64BE(offset);
        if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.close(1009, 'Payload exceeds maximum supported size');
          return;
        }
        payloadLen = Number(bigLen);
        offset += 8;
      }

      // Lectura de Masking Key (4 bytes)
      if (this.buffer.length < offset + 4) return;
      const maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;

      // Esperar a que el payload completo esté disponible
      if (this.buffer.length < offset + payloadLen) return;

      const rawPayload = this.buffer.subarray(offset, offset + payloadLen);

      // Desenmascarar payload in-place / copia
      const unmasked = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = rawPayload[i]! ^ maskKey[i % 4]!;
      }

      // Consumir el frame procesado del buffer acumulador
      this.buffer = this.buffer.subarray(offset + payloadLen);

      this.dispatchFrame(fin, opcode, unmasked);
    }
  }

  private dispatchFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === OPCODES.PING) {
      this.pong(payload);
      return;
    }

    if (opcode === OPCODES.PONG) {
      return;
    }

    if (opcode === OPCODES.CLOSE) {
      let code = 1000;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        if (payload.length > 2) {
          reason = payload.subarray(2).toString('utf8');
        }
      }

      // Si aún está OPEN, responder eco del close frame y terminar
      if (this.readyState === READY_STATE.OPEN) {
        this.readyState = READY_STATE.CLOSING;
        const echoPayload = Buffer.allocUnsafe(2);
        echoPayload.writeUInt16BE(code, 0);
        const echoFrame = encodeFrame(OPCODES.CLOSE, echoPayload);
        this.socket.write(echoFrame, () => {
          this.cleanup(code, reason);
          this.socket.end();
        });
      } else {
        this.cleanup(code, reason);
      }
      return;
    }

    // Manejo de fragmentación
    if (opcode === OPCODES.CONTINUATION) {
      this.fragmentBuffers.push(payload);
      if (fin) {
        const fullPayload = Buffer.concat(this.fragmentBuffers);
        const origOpcode = this.fragmentOpcode;
        this.fragmentBuffers = [];
        this.fragmentOpcode = 0;

        if (origOpcode === OPCODES.TEXT) {
          this.onMessage?.(fullPayload.toString('utf8'), false);
        } else if (origOpcode === OPCODES.BINARY) {
          this.onMessage?.(new Uint8Array(fullPayload), true);
        }
      }
      return;
    }

    if (!fin) {
      this.fragmentOpcode = opcode;
      this.fragmentBuffers = [payload];
      return;
    }

    if (opcode === OPCODES.TEXT) {
      this.onMessage?.(payload.toString('utf8'), false);
    } else if (opcode === OPCODES.BINARY) {
      this.onMessage?.(new Uint8Array(payload), true);
    }
  }

  private cleanup(code: number, reason: string): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.isClosed) return;
    this.isClosed = true;
    this.readyState = READY_STATE.CLOSED;
    if (this.onClose) {
      this.onClose(code, reason);
    }
  }
}

/**
 * Codifica un frame WebSocket saliente no enmascarado (Servidor -> Cliente, RFC 6455 §5.1).
 */
export function encodeFrame(opcode: number, data: string | Uint8Array): Buffer {
  let payloadBuf: Buffer;
  if (typeof data === 'string') {
    payloadBuf = Buffer.from(data, 'utf8');
  } else if (Buffer.isBuffer(data)) {
    payloadBuf = data;
  } else {
    payloadBuf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  const len = payloadBuf.length;
  let headerLen = 2;
  if (len >= 126 && len <= 65535) {
    headerLen = 4;
  } else if (len > 65535) {
    headerLen = 10;
  }

  const frame = Buffer.allocUnsafe(headerLen + len);
  // FIN = 1, RSV = 0 -> 0x80 | (opcode & 0x0F)
  frame[0] = 0x80 | (opcode & 0x0f);

  if (len < 126) {
    frame[1] = len; // MASK = 0
  } else if (len <= 65535) {
    frame[1] = 126; // MASK = 0
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 127; // MASK = 0
    frame.writeBigUInt64BE(BigInt(len), 2);
  }

  payloadBuf.copy(frame, headerLen);
  return frame;
}

/**
 * Calcula el valor `Sec-WebSocket-Accept` según RFC 6455 §4.2.2.
 */
export function computeAcceptKey(secWebSocketKey: string): string {
  return createHash('sha1')
    .update(secWebSocketKey + WS_GUID)
    .digest('base64');
}

/**
 * Realiza el handshake HTTP 101 Switching Protocols y devuelve una instancia `NativeWebSocket`.
 * Si las cabeceras de handshake son inválidas, responde 400 Bad Request y destruye el socket.
 */
export function upgradeToWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): NativeWebSocket | null {
  const upgradeHeader = req.headers.upgrade;
  const connectionHeader = req.headers.connection;
  const key = req.headers['sec-websocket-key'];

  const isUpgradeWs =
    typeof upgradeHeader === 'string' && upgradeHeader.toLowerCase() === 'websocket';
  const isConnectionUpgrade =
    typeof connectionHeader === 'string' &&
    connectionHeader
      .toLowerCase()
      .split(',')
      .some((c) => c.trim() === 'upgrade');
  const hasKey = typeof key === 'string' && key.trim().length > 0;

  if (!isUpgradeWs || !isConnectionUpgrade || !hasKey) {
    const response =
      'HTTP/1.1 400 Bad Request\r\n' +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'Content-Length: 11\r\n\r\n' +
      'Bad Request';
    try {
      socket.write(response);
    } finally {
      socket.destroy();
    }
    return null;
  }

  const acceptKey = computeAcceptKey(key.trim());
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n',
  ].join('\r\n');

  socket.write(responseHeaders);
  return new NativeWebSocket(socket, head);
}
