import { describe, expect, it, beforeEach } from 'vitest';
import {
  InMemorySubmissionRepository,
  InMemoryRejectedMessageRepository,
} from '../src/repositories/memory.js';
import type { CreateSubmissionInput } from '../src/repositories/types.js';

describe('Judge Lease Fencing & Rejected Messages (S19)', () => {
  let subRepo: InMemorySubmissionRepository;
  let rejectedRepo: InMemoryRejectedMessageRepository;

  const baseSubmissionInput: CreateSubmissionInput = {
    id: 'sub-test-001',
    match_id: 'match-100',
    round_id: 'round-1',
    user_id: 'user-alpha',
    problem_id: 'prob-two-sum',
    language: 'python',
    source_code: 'def solve(): return 42',
    time_limit_ms: 2000,
    memory_limit_mb: 256,
    admission_seq: 1,
  };

  beforeEach(() => {
    subRepo = new InMemorySubmissionRepository();
    rejectedRepo = new InMemoryRejectedMessageRepository();
  });

  describe('claimSubmission', () => {
    it('primer worker reclama exitosamente un envío pendiente en cola', async () => {
      await subRepo.createSubmission(baseSubmissionInput);

      const claim = await subRepo.claimSubmission('sub-test-001', 'worker-1', 30000);
      expect(claim.status).toBe('acquired');
      expect(typeof claim.attempt_token).toBe('string');
      expect(claim.attempt_token!.length).toBeGreaterThan(0);

      const updated = await subRepo.findSubmissionById('sub-test-001');
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('judging');
    });

    it('segundo worker recibe busy si el lease aún no ha expirado', async () => {
      await subRepo.createSubmission(baseSubmissionInput);

      const claim1 = await subRepo.claimSubmission('sub-test-001', 'worker-1', 30000);
      expect(claim1.status).toBe('acquired');

      const claim2 = await subRepo.claimSubmission('sub-test-001', 'worker-2', 30000);
      expect(claim2.status).toBe('busy');
      expect(claim2.attempt_token).toBeUndefined();
    });

    it('devuelve completed si el envío ya fue juzgado', async () => {
      await subRepo.createSubmission({
        ...baseSubmissionInput,
        status: 'completed',
        verdict: 'AC',
      });

      const claim = await subRepo.claimSubmission('sub-test-001', 'worker-1');
      expect(claim.status).toBe('completed');
    });

    it('lanza error si el envío no existe', async () => {
      await expect(subRepo.claimSubmission('sub-inexistente', 'worker-1')).rejects.toThrow(
        'Envío no encontrado',
      );
    });

    it('permite a un nuevo worker reclamar el envío si el lease expiró', async () => {
      await subRepo.createSubmission(baseSubmissionInput);

      const t0 = new Date('2026-09-16T12:00:00Z').toISOString();
      const claim1 = await subRepo.claimSubmission('sub-test-001', 'worker-1', 10000, t0);
      expect(claim1.status).toBe('acquired');

      // 15 segundos después (lease expirado de 10s)
      const t1 = new Date('2026-09-16T12:00:15Z').toISOString();
      const claim2 = await subRepo.claimSubmission('sub-test-001', 'worker-2', 10000, t1);
      expect(claim2.status).toBe('acquired');
      expect(claim2.attempt_token).not.toBe(claim1.attempt_token);
    });
  });

  describe('persistIfCurrent', () => {
    it('persiste exitosamente el resultado si el attempt_token coincide', async () => {
      await subRepo.createSubmission(baseSubmissionInput);

      const claim = await subRepo.claimSubmission('sub-test-001', 'worker-1');
      expect(claim.status).toBe('acquired');

      const persistStatus = await subRepo.persistIfCurrent(
        {
          submission_id: 'sub-test-001',
          verdict: 'AC',
          passed_cases: 5,
          total_cases: 5,
          exec_time_ms: 120,
          compile_output: null,
          judge_error: null,
        },
        claim.attempt_token!,
      );

      expect(persistStatus).toBe('stored');

      const finished = await subRepo.findSubmissionById('sub-test-001');
      expect(finished!.status).toBe('completed');
      expect(finished!.verdict).toBe('AC');
      expect(finished!.passed_cases).toBe(5);
      expect(finished!.total_cases).toBe(5);
      expect(finished!.exec_time_ms).toBe(120);
    });

    it('bloquea (fenced) a un worker zombi cuyo lease fue tomado por otro', async () => {
      await subRepo.createSubmission(baseSubmissionInput);

      const t0 = new Date('2026-09-16T12:00:00Z').toISOString();
      const claim1 = await subRepo.claimSubmission('sub-test-001', 'worker-1', 5000, t0);

      // Worker 2 reclama tras expirar el lease
      const t1 = new Date('2026-09-16T12:00:10Z').toISOString();
      const claim2 = await subRepo.claimSubmission('sub-test-001', 'worker-2', 5000, t1);
      expect(claim2.status).toBe('acquired');

      // Worker 1 tardío intenta persistir con token obsoleto
      const persistStatus1 = await subRepo.persistIfCurrent(
        {
          submission_id: 'sub-test-001',
          verdict: 'TLE',
          passed_cases: 2,
          total_cases: 5,
          exec_time_ms: 2100,
        },
        claim1.attempt_token!,
      );

      expect(persistStatus1).toBe('fenced');

      // Worker 2 persiste con su token válido
      const persistStatus2 = await subRepo.persistIfCurrent(
        {
          submission_id: 'sub-test-001',
          verdict: 'AC',
          passed_cases: 5,
          total_cases: 5,
          exec_time_ms: 150,
        },
        claim2.attempt_token!,
      );

      expect(persistStatus2).toBe('stored');

      const finished = await subRepo.findSubmissionById('sub-test-001');
      expect(finished!.status).toBe('completed');
      expect(finished!.verdict).toBe('AC');
    });

    it('devuelve completed idempotentemente si el envío ya estaba completado', async () => {
      await subRepo.createSubmission(baseSubmissionInput);
      const claim = await subRepo.claimSubmission('sub-test-001', 'worker-1');

      await subRepo.persistIfCurrent(
        {
          submission_id: 'sub-test-001',
          verdict: 'AC',
          passed_cases: 5,
          total_cases: 5,
          exec_time_ms: 100,
        },
        claim.attempt_token!,
      );

      // Segundo intento de persistencia
      const duplicatePersist = await subRepo.persistIfCurrent(
        {
          submission_id: 'sub-test-001',
          verdict: 'AC',
          passed_cases: 5,
          total_cases: 5,
          exec_time_ms: 100,
        },
        claim.attempt_token!,
      );

      expect(duplicatePersist).toBe('completed');
    });

    it('lanza error si el envío no existe al persistir', async () => {
      await expect(
        subRepo.persistIfCurrent(
          {
            submission_id: 'sub-fantasma',
            verdict: 'WA',
            passed_cases: 0,
            total_cases: 1,
            exec_time_ms: 10,
          },
          'token-xyz',
        ),
      ).rejects.toThrow('Envío no encontrado');
    });
  });

  describe('InMemoryRejectedMessageRepository', () => {
    it('registra mensajes rechazados de forma idempotente', async () => {
      const recordedFirst = await rejectedRepo.recordRejected(
        'stream-msg-101',
        'Payload corrupto: JSON inválido',
      );
      expect(recordedFirst).toBe(true);

      const recordedSecond = await rejectedRepo.recordRejected(
        'stream-msg-101',
        'Payload corrupto: JSON inválido',
      );
      expect(recordedSecond).toBe(false);

      expect(await rejectedRepo.countRejectedMessages()).toBe(1);
    });

    it('recupera detalles del mensaje rechazado', async () => {
      await rejectedRepo.recordRejected(
        'stream-msg-202',
        'Límites excedidos: memory_limit_mb > 512',
      );

      const found = await rejectedRepo.findRejectedMessageById('stream-msg-202');
      expect(found).not.toBeNull();
      expect(found!.message_id).toBe('stream-msg-202');
      expect(found!.reason).toBe('Límites excedidos: memory_limit_mb > 512');
      expect(typeof found!.rejected_at).toBe('string');
    });

    it('retorna null para mensajes no registrados', async () => {
      const found = await rejectedRepo.findRejectedMessageById('stream-msg-inexistente');
      expect(found).toBeNull();
    });

    it('no almacena código fuente ni casos de prueba sensibles (doc 04 §135)', async () => {
      const sanitizedReason = 'Veredicto inválido en payload recibido';
      await rejectedRepo.recordRejected('stream-msg-303', sanitizedReason);

      const found = await rejectedRepo.findRejectedMessageById('stream-msg-303');
      expect(found).not.toBeNull();
      expect(found).not.toHaveProperty('source_code');
      expect(found).not.toHaveProperty('cases');
      expect(found!.reason).not.toContain('def solve()');
    });
  });
});
