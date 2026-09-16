/**
 * Estado y gestión de un documento Yjs en memoria (doc 04 §79-88).
 *
 * Características clave:
 * - Vinculado a una ronda y generación específicas.
 * - Invariante H12: Límite estricto de tamaño de 256 KiB (`MAX_YDOC_BYTES`).
 * - Congelación defensiva antes de capturar el snapshot terminal.
 * - Rechazo de updates obsoletos pertenecientes a generaciones anteriores.
 */

import { MAX_YDOC_BYTES } from '@duelodev/shared';
import type { CodeSnapshot, YjsClientConnection, YjsDocumentMetadata } from './types.js';

export interface YjsDocumentOptions {
  matchId: string;
  userId: string;
  roundId: string;
  generation?: number | undefined;
  initialCode?: string | undefined;
  maxBytes?: number | undefined;
}

export class YjsDocument {
  readonly matchId: string;
  readonly userId: string;
  readonly roundId: string;
  readonly generation: number;
  private readonly maxBytes: number;

  private isFrozenState = false;
  private content: string;
  private totalByteSize = 0;
  private readonly updates: Uint8Array[] = [];
  private readonly observers = new Map<string, YjsClientConnection>();

  readonly createdAt: number;
  private lastUpdatedAt: number;
  private lastSnapshotAt: number;

  constructor(options: YjsDocumentOptions) {
    this.matchId = options.matchId;
    this.userId = options.userId;
    this.roundId = options.roundId;
    this.generation = options.generation ?? 1;
    this.content = options.initialCode ?? '';
    this.maxBytes = options.maxBytes ?? MAX_YDOC_BYTES;

    const now = Date.now();
    this.createdAt = now;
    this.lastUpdatedAt = now;
    this.lastSnapshotAt = now;

    // Medir tamaño inicial si hay código
    if (this.content.length > 0) {
      this.totalByteSize = Buffer.byteLength(this.content, 'utf8');
    }
  }

  get isFrozen(): boolean {
    return this.isFrozenState;
  }

  get currentBytes(): number {
    return this.totalByteSize;
  }

  get observerCount(): number {
    return this.observers.size;
  }

  /**
   * Registra un observador (conexión de lectura o escritura) para recibir actualizaciones.
   */
  addObserver(client: YjsClientConnection): void {
    this.observers.set(client.id, client);
  }

  /**
   * Elimina un observador cuando se desconecta.
   */
  removeObserver(clientId: string): void {
    this.observers.delete(clientId);
  }

  /**
   * Aplica una actualización binaria al documento.
   *
   * Reglas de negocio (doc 04 §79-88):
   * 1. Rechaza updates de generaciones anteriores o desfasadas.
   * 2. Rechaza si el documento ha sido congelado (p.ej. tras finalizar).
   * 3. Rechaza si el nuevo tamaño excede el límite de 256 KiB (invariante H12).
   *
   * @param update Buffer binario de la actualización de Yjs.
   * @param generation Generación indicada por el cliente.
   * @param updatedText Texto plano resultante si se negoció proyección en el cliente.
   * @param sourceClientId ID del cliente que envió el update (para no rebotárselo).
   * @returns true si se aplicó exitosamente, false si fue rechazado.
   */
  applyUpdate(
    update: Uint8Array,
    generation: number,
    updatedText?: string | undefined,
    sourceClientId?: string | undefined,
  ): { applied: boolean; reason?: string } {
    if (this.isFrozenState) {
      return { applied: false, reason: 'El documento está congelado y no admite más cambios.' };
    }

    if (generation !== this.generation) {
      return {
        applied: false,
        reason: `Generación desfasada. Actual: ${this.generation}, recibida: ${generation}.`,
      };
    }

    const projectedSize = this.totalByteSize + update.byteLength;
    if (projectedSize > this.maxBytes) {
      return {
        applied: false,
        reason: `Límite de documento excedido (${projectedSize} B > ${this.maxBytes} B).`,
      };
    }

    // Aplicar
    this.updates.push(update);
    this.totalByteSize = projectedSize;
    this.lastUpdatedAt = Date.now();

    if (typeof updatedText === 'string') {
      this.content = updatedText;
    }

    // Difundir update binario a los observadores (excluyendo al autor)
    for (const [id, observer] of this.observers) {
      if (id !== sourceClientId) {
        try {
          observer.send(update);
        } catch {
          // Si el observer falló al enviar, se limpiará en disconnect
        }
      }
    }

    return { applied: true };
  }

  /**
   * Congela el documento impidiendo futuras mutaciones antes de capturar el snapshot terminal.
   */
  freeze(): void {
    this.isFrozenState = true;
  }

  /**
   * Captura un snapshot de código inmutable para persistencia en Redis o PostgreSQL.
   */
  captureSnapshot(isRevealed: boolean): CodeSnapshot {
    this.lastSnapshotAt = Date.now();
    return {
      matchId: this.matchId,
      userId: this.userId,
      roundId: this.roundId,
      generation: this.generation,
      code: this.content,
      capturedAt: new Date(this.lastSnapshotAt).toISOString(),
      isRevealed,
    };
  }

  /**
   * Obtiene el código fuente actual en texto plano.
   */
  getText(): string {
    return this.content;
  }

  /**
   * Obtiene los metadatos de auditoría y monitoreo del documento.
   */
  getMetadata(): YjsDocumentMetadata {
    return {
      matchId: this.matchId,
      userId: this.userId,
      generation: this.generation,
      roundId: this.roundId,
      isFrozen: this.isFrozenState,
      totalBytes: this.totalByteSize,
      createdAt: this.createdAt,
      lastUpdatedAt: this.lastUpdatedAt,
      lastSnapshotAt: this.lastSnapshotAt,
    };
  }
}
