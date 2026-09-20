import type { IncomingMessage } from 'node:http';
import { Duplex, PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  computeAcceptKey,
  encodeFrame,
  NativeWebSocket,
  OPCODES,
  upgradeToWebSocket,
} from '../src/transport/websocket.js';

describe('RFC 6455 Native WebSocket Unit Tests', () => {
  describe('computeAcceptKey', () => {
    it('calcula correctamente el accept key RFC 6455', () => {
      // Ejemplo estándar RFC 6455 §1.3
      const key = 'dGhlIHNhbXBsZSBub25jZQ==';
      const expected = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
      expect(computeAcceptKey(key)).toBe(expected);
    });
  });

  describe('encodeFrame', () => {
    it('codifica frame de texto corto (< 126 bytes) no enmascarado', () => {
      const text = 'Hello';
      const frame = encodeFrame(OPCODES.TEXT, text);

      expect(frame[0]).toBe(0x81); // FIN = 1, Opcode = 1
      expect(frame[1]).toBe(5); // MASK = 0, Length = 5
      expect(frame.subarray(2).toString('utf8')).toBe('Hello');
    });

    it('codifica frame mediano (126 <= len <= 65535)', () => {
      const payload = Buffer.alloc(200, 'x');
      const frame = encodeFrame(OPCODES.BINARY, payload);

      expect(frame[0]).toBe(0x82); // FIN = 1, Opcode = 2
      expect(frame[1]).toBe(126); // MASK = 0, Extended 16-bit
      expect(frame.readUInt16BE(2)).toBe(200);
      expect(frame.subarray(4).length).toBe(200);
    });
  });

  describe('NativeWebSocket parser & frame dispatch', () => {
    function createClientMaskedFrame(
      opcode: number,
      data: Buffer,
      fin = true,
      maskKey = Buffer.from([1, 2, 3, 4]),
    ): Buffer {
      const len = data.length;
      let headerLen = 2;
      if (len >= 126 && len <= 65535) {
        headerLen = 4;
      }

      const frame = Buffer.alloc(headerLen + 4 + len);
      frame[0] = (fin ? 0x80 : 0x00) | opcode;

      if (len < 126) {
        frame[1] = 0x80 | len; // MASK = 1
        maskKey.copy(frame, 2);
      } else {
        frame[1] = 0x80 | 126; // MASK = 1
        frame.writeUInt16BE(len, 2);
        maskKey.copy(frame, 4);
      }

      const payloadOffset = headerLen + 4;
      for (let i = 0; i < len; i++) {
        frame[payloadOffset + i] = data[i]! ^ maskKey[i % 4]!;
      }

      return frame;
    }

    function createStreamPair(): { clientStream: Duplex; serverStream: Duplex } {
      const clientToServer = new PassThrough();
      const serverToClient = new PassThrough();

      const clientStream = Duplex.from({
        readable: serverToClient,
        writable: clientToServer,
      });

      const serverStream = Duplex.from({
        readable: clientToServer,
        writable: serverToClient,
      });

      clientStream.on('error', () => {});
      serverStream.on('error', () => {});

      return { clientStream, serverStream };
    }

    it('parsea mensajes de texto enmascarados correctamente', async () => {
      const { clientStream, serverStream } = createStreamPair();
      const ws = new NativeWebSocket(serverStream);

      const receivedPromise = new Promise<{ data: string; isBinary: boolean }>((resolve) => {
        ws.onMessage = (data, isBinary) => resolve({ data: data as string, isBinary });
      });

      const frame = createClientMaskedFrame(OPCODES.TEXT, Buffer.from('Testing WebSocket'));
      clientStream.write(frame);

      const res = await receivedPromise;
      expect(res.data).toBe('Testing WebSocket');
      expect(res.isBinary).toBe(false);
    });

    it('parsea mensajes binarios enmascarados correctamente', async () => {
      const { clientStream, serverStream } = createStreamPair();
      const ws = new NativeWebSocket(serverStream);

      const receivedPromise = new Promise<{ data: Uint8Array; isBinary: boolean }>((resolve) => {
        ws.onMessage = (data, isBinary) => resolve({ data: data as Uint8Array, isBinary });
      });

      const binaryData = Buffer.from([10, 20, 30, 40, 50]);
      const frame = createClientMaskedFrame(OPCODES.BINARY, binaryData);
      clientStream.write(frame);

      const res = await receivedPromise;
      expect(res.data).toEqual(new Uint8Array([10, 20, 30, 40, 50]));
      expect(res.isBinary).toBe(true);
    });

    it('cierra con 1009 un mensaje que supera el máximo configurado', async () => {
      const { clientStream, serverStream } = createStreamPair();
      const ws = new NativeWebSocket(serverStream, undefined, 5);
      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.onClose = (code, reason) => resolve({ code, reason });
      });

      clientStream.write(createClientMaskedFrame(OPCODES.TEXT, Buffer.from('123456')));

      await expect(closePromise).resolves.toEqual({
        code: 1009,
        reason: 'WebSocket message exceeds maximum size',
      });
    });

    it('suma los bytes de los fragmentos antes de aceptarlos', async () => {
      const { clientStream, serverStream } = createStreamPair();
      const ws = new NativeWebSocket(serverStream, undefined, 6);
      const closePromise = new Promise<number>((resolve) => {
        ws.onClose = (code) => resolve(code);
      });

      clientStream.write(createClientMaskedFrame(OPCODES.TEXT, Buffer.from('1234'), false));
      clientStream.write(createClientMaskedFrame(OPCODES.CONTINUATION, Buffer.from('567'), true));

      await expect(closePromise).resolves.toBe(1009);
    });

    it('rechaza los frames de control fragmentados o mayores a 125 bytes', async () => {
      const { clientStream, serverStream } = createStreamPair();
      const ws = new NativeWebSocket(serverStream);
      const closePromise = new Promise<number>((resolve) => {
        ws.onClose = (code) => resolve(code);
      });

      clientStream.write(createClientMaskedFrame(OPCODES.PING, Buffer.alloc(126)));

      await expect(closePromise).resolves.toBe(1002);
    });

    it('responde a Ping con Pong automáticamente', async () => {
      const { clientStream, serverStream } = createStreamPair();
      const ws = new NativeWebSocket(serverStream);
      expect(ws).toBeDefined();

      const pongPromise = new Promise<Buffer>((resolve) => {
        clientStream.on('data', (chunk: Buffer) => {
          resolve(chunk);
        });
      });

      const pingPayload = Buffer.from('ping-payload');
      const pingFrame = createClientMaskedFrame(OPCODES.PING, pingPayload);
      clientStream.write(pingFrame);

      const response = await pongPromise;
      expect(response[0]).toBe(0x8a); // FIN = 1, Opcode = 0xA (Pong)
      expect(response.subarray(2).toString('utf8')).toBe('ping-payload');
    });

    it('rechaza frames de cliente no enmascarados con código 1002 (RFC 6455)', async () => {
      const { clientStream, serverStream } = createStreamPair();
      const ws = new NativeWebSocket(serverStream);

      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.onClose = (code, reason) => resolve({ code, reason });
      });

      // Frame sin enmascarar (MASK bit = 0)
      const unmaskedFrame = Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
      clientStream.write(unmaskedFrame);

      const res = await closePromise;
      expect(res.code).toBe(1002);
      expect(res.reason).toContain('Client frames must be masked');
    });

    it('soporta fragmentación de frames WebSocket (FIN=0 seguido de FIN=1)', async () => {
      const { clientStream, serverStream } = createStreamPair();
      const ws = new NativeWebSocket(serverStream);

      const messagePromise = new Promise<string>((resolve) => {
        ws.onMessage = (data) => resolve(data as string);
      });

      // Fragmento 1: FIN=0, Opcode=TEXT
      const frag1 = createClientMaskedFrame(OPCODES.TEXT, Buffer.from('Hello '), false);
      // Fragmento 2: FIN=1, Opcode=CONTINUATION
      const frag2 = createClientMaskedFrame(OPCODES.CONTINUATION, Buffer.from('World!'), true);

      clientStream.write(frag1);
      clientStream.write(frag2);

      const fullMessage = await messagePromise;
      expect(fullMessage).toBe('Hello World!');
    });
  });

  describe('upgradeToWebSocket', () => {
    it('retorna null y envía 400 Bad Request si faltan cabeceras obligatorias', () => {
      const socket = new PassThrough();
      const req = {
        headers: {
          upgrade: 'not-websocket',
          connection: 'close',
        },
      } as unknown as IncomingMessage;

      let responseData = '';
      socket.on('data', (chunk: Buffer) => {
        responseData += chunk.toString('utf8');
      });

      const res = upgradeToWebSocket(req, socket, Buffer.alloc(0));
      expect(res).toBeNull();
      expect(responseData).toContain('HTTP/1.1 400 Bad Request');
    });
  });
});
