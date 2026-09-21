/**
 * Hub central de coordinación para documentos colaborativos Yjs (doc 04 §79-88).
 *
 * Responsabilidades:
 * - Gestiona el ciclo de vida de los documentos Yjs indexados por `${matchId}:${userId}`.
 * - Verifica autorización de lectura y escritura en `/yjs/{match_id}/{user_id}`.
 * - Aplica el avance de generaciones al cambiar de ronda/problema, archivando el snapshot previo.
 * - Aplica el snapshot periódico (cada 10s por defecto) para persistencia en Redis/PostgreSQL.
 * - Congela documentos y captura snapshots finales al terminar la partida.
 * - Limpieza de timers al cerrar el servidor.
 */

import { createYjsSyncMessage, type Logger } from '@duelodev/shared';
import type { MatchStore } from '../store/types.js';
import type { RealtimeMatchSession } from '../types.js';
import { authorizeYjsAccess, parseYjsPath } from './auth.js';
import { HIDDEN_CODE_PREVIEW, YjsDocument } from './document.js';
import { playerRoundId } from '../gamemodes/round-id.js';
import type {
  CodeSnapshot,
  YjsAuthContext,
  YjsClientConnection,
  YjsSnapshotContext,
} from './types.js';

export interface YjsHubOptions {
  matchStore: MatchStore;
  logger?: Logger | undefined;
  /** Intervalo para captura periódica de snapshots en ms (defecto 10000ms = 10s). */
  snapshotIntervalMs?: number | undefined;
  /** Callback opcional de persistencia de snapshots (Redis o BD). */
  onSnapshotPersist?: ((snapshot: CodeSnapshot) => Promise<void>) | undefined;
}

export class YjsHub {
  private readonly matchStore: MatchStore;
  private readonly logger: Logger | undefined;
  private readonly snapshotIntervalMs: number;
  private readonly onSnapshotPersist: ((snapshot: CodeSnapshot) => Promise<void>) | undefined;

  /** Documentos activos indexados por clave `${matchId}:${userId}`. */
  private readonly activeDocuments = new Map<string, YjsDocument>();
  /** Snapshots capturados indexados por `${matchId}:${userId}:${roundId}`. */
  private readonly snapshots = new Map<string, CodeSnapshot>();
  /** Capturas terminales retenidas sólo mientras se completa un reintento durable. */
  private readonly pendingTerminalSnapshots = new Map<string, CodeSnapshot[]>();
  private readonly finalizedMatches = new Set<string>();

  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: YjsHubOptions) {
    this.matchStore = options.matchStore;
    this.logger = options.logger;
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 10_000;
    this.onSnapshotPersist = options.onSnapshotPersist;

    // Iniciar temporizador periódico de snapshots si el intervalo es positivo
    if (this.snapshotIntervalMs > 0) {
      this.snapshotTimer = setInterval(() => {
        void this.runPeriodicSnapshots();
      }, this.snapshotIntervalMs);
    }
  }

  private docKey(matchId: string, userId: string): string {
    return `${matchId}:${userId}`;
  }

  private snapshotKey(matchId: string, userId: string, roundId: string): string {
    return `${matchId}:${userId}:${roundId}`;
  }

  private isActivePlayer(session: RealtimeMatchSession, userId: string): boolean {
    const player = session.players.get(userId);
    return player !== undefined && player.connection !== 'left';
  }

  /**
   * Procesa una solicitud de conexión a `/yjs/{match_id}/{user_id}`.
   *
   * 1. Parsea el pathname y extrae matchId y targetUserId.
   * 2. Consulta el estado de la partida en el MatchStore.
   * 3. Evalúa la autorización (doc 04 §79-88):
   *    - Escritura: únicamente el dueño (`auth.userId === targetUserId`).
   *    - Lectura: el dueño siempre; los rivales sólo tras consentimiento explícito.
   * 4. Si se autoriza, une al cliente como observador del documento.
   */
  async handleConnection(
    pathname: string,
    client: YjsClientConnection,
    auth: YjsAuthContext,
    initialCode?: string,
  ): Promise<{ authorized: boolean; reason?: string; document?: YjsDocument }> {
    const parsed = parseYjsPath(pathname);
    if (!parsed) {
      client.close(4000, 'Ruta Yjs inválida.');
      return { authorized: false, reason: 'Ruta no cumple /yjs/{match_id}/{user_id}' };
    }

    const { matchId, targetUserId } = parsed;

    const session = await this.matchStore.getMatch(matchId);
    if (!session) {
      client.close(4004, 'Partida no encontrada.');
      return { authorized: false, reason: 'Partida no encontrada.' };
    }

    const isMember = this.isActivePlayer(session, auth.userId);
    const targetPlayer = session.players.get(targetUserId);

    if (!targetPlayer) {
      client.close(4004, 'Jugador objetivo no pertenece a la partida.');
      return { authorized: false, reason: 'Jugador objetivo no pertenece a la partida.' };
    }

    const decision = authorizeYjsAccess({
      auth,
      matchId,
      targetUserId,
      isMember,
    });

    if (!decision.allowed) {
      const failureReason = decision.reason ?? 'Acceso no autorizado.';
      client.close(4003, failureReason);
      return { authorized: false, reason: failureReason };
    }

    // Obtener o crear el documento Yjs
    const key = this.docKey(matchId, targetUserId);
    let doc = this.activeDocuments.get(key);

    if (!doc) {
      const snapshotContext = this.getSnapshotContext(session, targetUserId);
      doc = new YjsDocument({
        matchId,
        userId: targetUserId,
        roundId: snapshotContext.roundId,
        problemId: snapshotContext.problemId,
        generation: 1,
        initialCode,
      });
      this.activeDocuments.set(key, doc);
    }

    doc.addObserver(client);

    client.sendText?.(
      JSON.stringify(
        createYjsSyncMessage({
          match_id: matchId,
          target_user_id: targetUserId,
          round_id: doc.roundId,
          generation: doc.generation,
          source_code:
            auth.userId === targetUserId || targetPlayer.is_revealed
              ? doc.getText()
              : HIDDEN_CODE_PREVIEW,
        }),
      ),
    );

    this.logger?.info('Conexión Yjs autorizada', {
      match_id: matchId,
      user_id: auth.userId,
      target_user_id: targetUserId,
      can_write: decision.canWrite,
      generation: doc.generation,
    });

    return { authorized: true, document: doc };
  }

  /**
   * Aplica una actualización binaria proveniente de un cliente.
   */
  async handleIncomingUpdate(
    client: YjsClientConnection,
    update: Uint8Array,
    generation: number,
    updatedText?: string,
  ): Promise<{ applied: boolean; reason?: string }> {
    if (!client.isOwner || client.userId !== client.targetUserId) {
      return {
        applied: false,
        reason: 'Solo el dueño del documento puede enviar actualizaciones.',
      };
    }
    return this.handleIncomingBinaryUpdate(client, update, generation, updatedText);
  }

  /** Variante asíncrona del transporte binario con el mismo filtro de permisos. */
  async handleIncomingBinaryUpdate(
    client: YjsClientConnection,
    update: Uint8Array,
    generation: number,
    updatedText?: string,
  ): Promise<{ applied: boolean; reason?: string }> {
    if (!client.isOwner || client.userId !== client.targetUserId) {
      return {
        applied: false,
        reason: 'Solo el dueño del documento puede enviar actualizaciones.',
      };
    }

    const session = await this.matchStore.getMatch(client.matchId);
    if (!session) return { applied: false, reason: 'Partida no encontrada.' };

    if (session.status !== 'running' && session.status !== 'settling') {
      return { applied: false, reason: 'La partida ya no acepta cambios de código.' };
    }

    if (!this.isActivePlayer(session, client.userId)) {
      return { applied: false, reason: 'El jugador ya no participa activamente en la partida.' };
    }

    const doc = this.activeDocuments.get(this.docKey(client.matchId, client.targetUserId));
    if (!doc) return { applied: false, reason: 'Documento Yjs no encontrado.' };

    return doc.applyUpdate(
      update,
      generation,
      updatedText,
      client.id,
      (observer) =>
        this.isActivePlayer(session, observer.userId) &&
        (observer.userId === client.targetUserId ||
          (session.players.get(client.targetUserId)?.is_revealed ?? false)),
    );
  }

  /**
   * Aplica una actualización textual del editor web y filtra la difusión con
   * el estado de revelación leído del store en el mismo ciclo del update.
   */
  async handleIncomingTextUpdate(
    client: YjsClientConnection,
    sourceCode: string,
    generation: number,
  ): Promise<{ applied: boolean; reason?: string }> {
    if (!client.isOwner || client.userId !== client.targetUserId) {
      return {
        applied: false,
        reason: 'Solo el dueño del documento puede enviar actualizaciones.',
      };
    }

    const session = await this.matchStore.getMatch(client.matchId);
    if (!session) {
      return { applied: false, reason: 'Partida no encontrada.' };
    }

    if (session.status !== 'running' && session.status !== 'settling') {
      return { applied: false, reason: 'La partida ya no acepta cambios de código.' };
    }

    if (!this.isActivePlayer(session, client.userId)) {
      return { applied: false, reason: 'El jugador ya no participa activamente en la partida.' };
    }

    const key = this.docKey(client.matchId, client.targetUserId);
    const doc = this.activeDocuments.get(key);
    if (!doc) {
      return { applied: false, reason: 'Documento Yjs no encontrado.' };
    }

    return doc.applyTextUpdate(
      sourceCode,
      generation,
      client.id,
      (observer) =>
        this.isActivePlayer(session, observer.userId) &&
        (observer.userId === client.targetUserId ||
          (session.players.get(client.targetUserId)?.is_revealed ?? false)),
    );
  }

  /**
   * Aplica de inmediato una concesión o revocación de consentimiento a observadores conectados.
   * Al revocar, envía una sincronización vacía y nunca vuelve a emitir el código fuente.
   */
  async notifyRevealChanged(matchId: string, userId: string): Promise<void> {
    const session = await this.matchStore.getMatch(matchId);
    const owner = session?.players.get(userId);
    const doc = this.activeDocuments.get(this.docKey(matchId, userId));
    if (!session || !owner || !doc) return;

    doc.syncObservers(
      (observer) =>
        this.isActivePlayer(session, observer.userId) &&
        (observer.userId === userId || owner.is_revealed),
    );
  }

  /**
   * Desconecta un cliente de los documentos que observaba.
   */
  handleDisconnect(client: YjsClientConnection): void {
    const key = this.docKey(client.matchId, client.targetUserId);
    const doc = this.activeDocuments.get(key);
    if (doc) {
      doc.removeObserver(client.id);
    }
  }

  /**
   * Alias de `handleDisconnect` para compatibilidad de contratos.
   */
  removeClient(client: YjsClientConnection): void {
    this.handleDisconnect(client);
  }

  /**
   * Avanza la generación del documento al cambiar de problema/ronda (doc 04 §80-82).
   *
   * 1. Captura snapshot del código anterior.
   * 2. Congela el documento anterior.
   * 3. Crea un nuevo documento con `generation = prev.generation + 1` y la nueva `roundId`.
   */
  async advanceGeneration(
    matchId: string,
    userId: string,
    newRoundId: string,
    initialCode = '',
    problemId: string | null = null,
    isRevealed = false,
    activeUserIds: readonly string[] = [],
  ): Promise<YjsDocument> {
    const key = this.docKey(matchId, userId);
    const prevDoc = this.activeDocuments.get(key);

    if (prevDoc?.roundId === newRoundId && !prevDoc.isFrozen) return prevDoc;

    let nextGen = 1;
    if (prevDoc) {
      nextGen = prevDoc.generation + 1;
      prevDoc.freeze();

      // Guardar snapshot de la ronda que termina
      const snap = prevDoc.captureSnapshot(isRevealed);
      this.saveSnapshotInMemory(snap);
      await this.persistSnapshot(snap);
    }

    const newDoc = new YjsDocument({
      matchId,
      userId,
      roundId: newRoundId,
      problemId,
      generation: nextGen,
      initialCode,
    });

    this.activeDocuments.set(key, newDoc);
    if (prevDoc) {
      for (const observer of prevDoc.getObservers()) newDoc.addObserver(observer);
      const activeUsers = new Set(activeUserIds);
      newDoc.syncObservers(
        (observer) =>
          activeUsers.has(observer.userId) && (observer.userId === userId || isRevealed),
      );
    }

    this.logger?.info('Generación Yjs avanzada', {
      match_id: matchId,
      user_id: userId,
      round_id: newRoundId,
      generation: nextGen,
    });

    return newDoc;
  }

  /**
   * Finaliza todos los documentos de una partida (doc 04 §83-84).
   * Congela los documentos y captura snapshots terminales para PostgreSQL.
   */
  async finalizeMatch(matchId: string): Promise<CodeSnapshot[]> {
    if (this.finalizedMatches.has(matchId)) return [];

    let persistenceFailed = false;

    let finalSnapshots = this.pendingTerminalSnapshots.get(matchId);
    if (!finalSnapshots) {
      finalSnapshots = [];
      const session = await this.matchStore.getMatch(matchId);

      for (const [, doc] of this.activeDocuments) {
        if (doc.matchId === matchId) {
          doc.freeze();
          const player = session?.players.get(doc.userId);
          const isRevealed = player?.is_revealed ?? false;

          const snapshotContext = session
            ? this.getSnapshotContext(session, doc.userId)
            : undefined;
          const snap = doc.captureSnapshot(isRevealed, snapshotContext);
          this.saveSnapshotInMemory(snap);
          finalSnapshots.push(snap);
        }
      }
      this.pendingTerminalSnapshots.set(matchId, finalSnapshots);
    }

    for (const snapshot of finalSnapshots) {
      if (!(await this.persistSnapshot(snapshot))) persistenceFailed = true;
    }

    this.logger?.info('Documentos Yjs de partida finalizados', {
      match_id: matchId,
      snapshots_count: finalSnapshots.length,
    });

    if (persistenceFailed)
      throw new Error('No se pudieron persistir todos los snapshots terminales.');

    this.pendingTerminalSnapshots.delete(matchId);
    this.finalizedMatches.add(matchId);
    return finalSnapshots;
  }

  /**
   * Ejecuta la captura periódica de snapshots para todos los documentos activos (cada 10s).
   */
  async runPeriodicSnapshots(): Promise<void> {
    for (const [, doc] of this.activeDocuments) {
      if (!doc.isFrozen) {
        const session = await this.matchStore.getMatch(doc.matchId);
        if (!session || (session.status !== 'running' && session.status !== 'settling')) continue;
        const snap = doc.captureSnapshot(
          session.players.get(doc.userId)?.is_revealed ?? false,
          this.getSnapshotContext(session, doc.userId),
        );
        this.saveSnapshotInMemory(snap);
        await this.persistSnapshot(snap);
      }
    }
  }

  private getSnapshotContext(session: RealtimeMatchSession, userId: string): YjsSnapshotContext {
    if (session.status === 'lobby') {
      return { roundId: session.current_round_id || session.match_id, problemId: null };
    }

    const player = session.players.get(userId);
    const problemIndex =
      session.mode === 'puntos' ? session.current_round_idx : (player?.current_problem_idx ?? 0);
    return {
      roundId:
        session.mode === 'puntos'
          ? session.current_round_id
          : playerRoundId(session.match_id, userId, problemIndex),
      problemId: session.problem_ids?.[problemIndex] ?? null,
    };
  }

  private async persistSnapshot(snapshot: CodeSnapshot): Promise<boolean> {
    if (!this.onSnapshotPersist || !snapshot.problemId) return true;
    try {
      await this.onSnapshotPersist(snapshot);
      return true;
    } catch {
      this.logger?.warn('No se pudo persistir un snapshot Yjs', {
        match_id: snapshot.matchId,
        user_id: snapshot.userId,
        round_id: snapshot.roundId,
      });
      return false;
    }
  }

  private saveSnapshotInMemory(snap: CodeSnapshot): void {
    const key = this.snapshotKey(snap.matchId, snap.userId, snap.roundId);
    this.snapshots.set(key, snap);
  }

  /**
   * Obtiene un snapshot guardado por matchId, userId y roundId.
   */
  getSnapshot(matchId: string, userId: string, roundId: string): CodeSnapshot | null {
    const key = this.snapshotKey(matchId, userId, roundId);
    return this.snapshots.get(key) ?? null;
  }

  /**
   * Obtiene el documento activo de un jugador en una partida.
   */
  getDocument(matchId: string, userId: string): YjsDocument | null {
    const key = this.docKey(matchId, userId);
    return this.activeDocuments.get(key) ?? null;
  }

  /**
   * Cierra el hub Yjs, deteniendo timers periódicos.
   */
  close(): void {
    if (this.snapshotTimer !== null) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  // ────────────────── Introspección para pruebas ──────────────────────────

  get activeDocumentCount(): number {
    return this.activeDocuments.size;
  }

  get snapshotCount(): number {
    return this.snapshots.size;
  }
}
