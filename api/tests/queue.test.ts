import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  JUDGE_STREAM_KEY,
  JUDGE_STREAM_SCHEMA_VERSION,
  type CreateSubmissionRequest,
  type JudgeJobStreamMessage,
} from '@duelodev/shared';
import { InMemoryJudgeQueue } from '../src/queue/memory.js';
import { SubmissionReconciler } from '../src/queue/reconciler.js';
import {
  InMemoryRoomRepository,
  InMemorySubmissionRepository,
} from '../src/repositories/memory.js';
import { SubmissionService } from '../src/services/submissions.js';

describe('Judge Queue & Submission Reconciler (doc 04 §4, §5)', () => {
  const sampleValidJob: JudgeJobStreamMessage = {
    schema_version: JUDGE_STREAM_SCHEMA_VERSION,
    submission_id: randomUUID(),
    problem_id: randomUUID(),
    problem_version: 1,
    language: 'python',
    source_code: 'print("hello world")',
    time_limit_ms: 1000,
    memory_limit_mb: 256,
    cases_ref: 'cases/problem-123',
    enqueued_at_ms: Date.now(),
  };

  describe('InMemoryJudgeQueue', () => {
    it('encola un mensaje válido y genera ID de mensaje secuencial en judge:stream', async () => {
      const queue = new InMemoryJudgeQueue();
      const result = await queue.enqueue(sampleValidJob);

      expect(result.stream).toBe(JUDGE_STREAM_KEY);
      expect(result.messageId).toContain(String(sampleValidJob.enqueued_at_ms));
      expect(result.job.submission_id).toBe(sampleValidJob.submission_id);

      expect(queue.count()).toBe(1);
      const found = queue.findBySubmissionId(sampleValidJob.submission_id);
      expect(found).not.toBeNull();
      expect(found?.job.source_code).toBe('print("hello world")');
    });

    it('rechaza mensajes que violen los invariantes del contrato del stream', async () => {
      const queue = new InMemoryJudgeQueue();
      const invalidJob = {
        ...sampleValidJob,
        schema_version: 999, // schema_version inválida
      } as unknown as JudgeJobStreamMessage;

      await expect(queue.enqueue(invalidJob)).rejects.toThrow(
        'El mensaje no cumple los invariantes del contrato JudgeJobStreamMessage.',
      );
    });

    it('simula fallo de red/conexión con failNext()', async () => {
      const queue = new InMemoryJudgeQueue();
      queue.failNext(new Error('Redis connection timeout'));

      await expect(queue.enqueue(sampleValidJob)).rejects.toThrow('Redis connection timeout');

      // La siguiente llamada debe funcionar normalmente
      const secondTry = await queue.enqueue(sampleValidJob);
      expect(secondTry.messageId).toBeDefined();
    });
  });

  describe('Integración de despacho en SubmissionService', () => {
    it('publica automáticamente en judge:stream al admitir un envío exitoso', async () => {
      const submissionRepo = new InMemorySubmissionRepository();
      const roomRepo = new InMemoryRoomRepository();
      const queue = new InMemoryJudgeQueue();

      const hostId = randomUUID();
      const match = await roomRepo.createMatch({
        room_code: 'QUE01',
        mode: 'puntos',
        host_id: hostId,
        config: {
          mode: 'puntos',
          max_players: 2,
          categories: ['facil'],
          num_problems: 3,
          time_per_problem_s: 60,
        },
      });

      await roomRepo.addPlayer({
        match_id: match.id,
        user_id: hostId,
        is_ready: true,
        is_revealed: true,
      });

      await roomRepo.updateMatch(match.id, { status: 'running' });

      const service = new SubmissionService({
        submissionRepo,
        roomRepo,
        judgeQueue: queue,
      });

      const submissionReq: CreateSubmissionRequest = {
        match_id: match.id,
        round_id: randomUUID(),
        problem_id: randomUUID(),
        language: 'python',
        source_code: 'def solve(): return 42',
      };

      const result = await service.submit(
        hostId,
        submissionReq,
        null,
        1726358400000,
        'req-abc-123',
      );

      expect(result.response.status).toBe('queued');
      expect(result.response.submission_id).toBeDefined();

      // Verificar que el trabajo fue encolado en la cola con el contrato exacto
      expect(queue.count()).toBe(1);
      const enqueued = queue.findBySubmissionId(result.response.submission_id);
      expect(enqueued).not.toBeNull();
      expect(enqueued?.job.schema_version).toBe(1);
      expect(enqueued?.job.submission_id).toBe(result.response.submission_id);
      expect(enqueued?.job.cases_ref).toBe(`cases/${submissionReq.problem_id}`);
      expect(enqueued?.job.language).toBe('python');
      expect(enqueued?.job.request_id).toBe('req-abc-123');
      expect(enqueued?.job.enqueued_at_ms).toBe(1726358400000);
    });

    it('no falla el HTTP 202 si el encolado XADD falla tras persistir el envío (doc 04 §127)', async () => {
      const submissionRepo = new InMemorySubmissionRepository();
      const roomRepo = new InMemoryRoomRepository();
      const queue = new InMemoryJudgeQueue();

      const hostId = randomUUID();
      const match = await roomRepo.createMatch({
        room_code: 'QUE02',
        mode: 'puntos',
        host_id: hostId,
        config: {
          mode: 'puntos',
          max_players: 2,
          categories: ['facil'],
          num_problems: 3,
          time_per_problem_s: 60,
        },
      });

      await roomRepo.addPlayer({
        match_id: match.id,
        user_id: hostId,
        is_ready: true,
        is_revealed: true,
      });

      await roomRepo.updateMatch(match.id, { status: 'running' });

      const service = new SubmissionService({
        submissionRepo,
        roomRepo,
        judgeQueue: queue,
      });

      // Simular caída de Redis en la inserción XADD
      queue.failNext(new Error('Redis connection lost during XADD'));

      const submissionReq: CreateSubmissionRequest = {
        match_id: match.id,
        round_id: randomUUID(),
        problem_id: randomUUID(),
        language: 'cpp',
        source_code: 'int main() { return 0; }',
      };

      const result = await service.submit(hostId, submissionReq);

      // Debe responder 202 con el submission_id persistido en la BD
      expect(result.response.status).toBe('queued');
      const persisted = await submissionRepo.findSubmissionById(result.response.submission_id);
      expect(persisted).not.toBeNull();
      expect(persisted?.status).toBe('queued');

      // La cola no recibió el mensaje por el fallo simulado
      expect(queue.count()).toBe(0);
    });
  });

  describe('SubmissionReconciler (Recuperación de envíos huérfanos)', () => {
    it('reencola envíos pendientes durables cuyo período de gracia ha expirado', async () => {
      const submissionRepo = new InMemorySubmissionRepository();
      const queue = new InMemoryJudgeQueue();

      const reconciler = new SubmissionReconciler({
        submissionRepo,
        queue,
        gracePeriodMs: 2000,
      });

      const now = Date.now();

      // 1. Envío huérfano de hace 5 segundos (INSERT confirmado, XADD falló)
      const orphanSub = await submissionRepo.createSubmission({
        match_id: randomUUID(),
        round_id: randomUUID(),
        user_id: randomUUID(),
        problem_id: randomUUID(),
        language: 'python',
        source_code: 'print("recovered")',
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        admission_seq: 1,
        status: 'queued',
        received_at: new Date(now - 5000).toISOString(),
      });

      // 2. Envío muy reciente (hace 500 ms, dentro del período de gracia de 2s)
      await submissionRepo.createSubmission({
        match_id: randomUUID(),
        round_id: randomUUID(),
        user_id: randomUUID(),
        problem_id: randomUUID(),
        language: 'python',
        source_code: 'print("recent")',
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        admission_seq: 2,
        status: 'queued',
        received_at: new Date(now - 500).toISOString(),
      });

      // 3. Envío completado (no debe reencolarse)
      await submissionRepo.createSubmission({
        match_id: randomUUID(),
        round_id: randomUUID(),
        user_id: randomUUID(),
        problem_id: randomUUID(),
        language: 'python',
        source_code: 'print("done")',
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        admission_seq: 3,
        status: 'completed',
        received_at: new Date(now - 10000).toISOString(),
      });

      const stats = await reconciler.reconcileOnce(now);

      // Debe haber escaneado los envíos en status 'queued', reencolando solo el huérfano
      expect(stats.scanned).toBe(2);
      expect(stats.reenqueued).toBe(1);
      expect(stats.failed).toBe(0);

      // Verificar que el huérfano llegó a la cola
      expect(queue.count()).toBe(1);
      const enqueuedJob = queue.findBySubmissionId(orphanSub.id);
      expect(enqueuedJob).not.toBeNull();
      expect(enqueuedJob?.job.submission_id).toBe(orphanSub.id);
      expect(enqueuedJob?.job.cases_ref).toBe(`cases/${orphanSub.problem_id}`);
    });

    it('maneja fallos transitorios durante la reconciliación sin detenerse', async () => {
      const submissionRepo = new InMemorySubmissionRepository();
      const queue = new InMemoryJudgeQueue();

      const reconciler = new SubmissionReconciler({
        submissionRepo,
        queue,
        gracePeriodMs: 1000,
      });

      const now = Date.now();
      await submissionRepo.createSubmission({
        match_id: randomUUID(),
        round_id: randomUUID(),
        user_id: randomUUID(),
        problem_id: randomUUID(),
        language: 'python',
        source_code: 'print("will fail")',
        time_limit_ms: 1000,
        memory_limit_mb: 128,
        admission_seq: 1,
        status: 'queued',
        received_at: new Date(now - 3000).toISOString(),
      });

      queue.failNext(new Error('Redis cluster down'));
      const stats = await reconciler.reconcileOnce(now);

      expect(stats.scanned).toBe(1);
      expect(stats.reenqueued).toBe(0);
      expect(stats.failed).toBe(1);
    });

    it('inicia y detiene el timer periódico de reconciliación limpiamente', () => {
      const submissionRepo = new InMemorySubmissionRepository();
      const queue = new InMemoryJudgeQueue();

      const reconciler = new SubmissionReconciler({
        submissionRepo,
        queue,
        intervalMs: 10000,
      });

      expect(reconciler.active).toBe(false);
      reconciler.start();
      expect(reconciler.active).toBe(true);

      // Llamada redundante a start
      reconciler.start();
      expect(reconciler.active).toBe(true);

      reconciler.stop();
      expect(reconciler.active).toBe(false);

      // Llamada redundante a stop
      reconciler.stop();
      expect(reconciler.active).toBe(false);
    });
  });
});
