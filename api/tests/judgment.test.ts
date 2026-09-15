import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { JudgeDurableResult, JudgeResultNotification } from '@duelodev/shared';
import { InMemorySubmissionRepository } from '../src/repositories/memory.js';
import { InMemoryResultChannel } from '../src/queue/results.js';
import { JudgmentService } from '../src/services/judgment.js';
import { HttpError } from '../src/plugins/body-parser.js';

describe('Judgment Service and Results Channel (doc 04 §1, §4)', () => {
  describe('InMemoryResultChannel', () => {
    it('publica avisos válidos y notifica a los suscriptores', async () => {
      const channel = new InMemoryResultChannel();
      const received: JudgeResultNotification[] = [];

      const unsubscribe = channel.subscribe((notification) => {
        received.push(notification);
      });

      const notification: JudgeResultNotification = {
        submission_id: randomUUID(),
        match_id: randomUUID(),
        round_id: randomUUID(),
        user_id: randomUUID(),
        verdict: 'AC',
        passed: 10,
        total: 10,
        exec_time_ms: 120,
        request_id: 'req-123',
      };

      await channel.publishResult(notification);

      expect(received).toHaveLength(1);
      expect(received[0]?.submission_id).toBe(notification.submission_id);
      expect(received[0]?.verdict).toBe('AC');
      expect(channel.getPublishedHistory()).toHaveLength(1);

      // Desuscribir
      unsubscribe();
      await channel.publishResult({ ...notification, submission_id: randomUUID() });
      expect(received).toHaveLength(1); // No incrementa
      expect(channel.getPublishedHistory()).toHaveLength(2);
    });

    it('rechaza avisos que no cumplen con los invariantes de JudgeResultNotification', async () => {
      const channel = new InMemoryResultChannel();

      // passed > total
      const invalidNotification = {
        submission_id: randomUUID(),
        match_id: randomUUID(),
        round_id: randomUUID(),
        user_id: randomUUID(),
        verdict: 'AC' as const,
        passed: 15,
        total: 10,
        exec_time_ms: 100,
      };

      await expect(channel.publishResult(invalidNotification)).rejects.toThrow();
    });

    it('aísla excepciones de suscriptores para no bloquear al resto', async () => {
      const channel = new InMemoryResultChannel();
      const results: string[] = [];

      channel.subscribe(() => {
        throw new Error('Crash in subscriber');
      });

      channel.subscribe((n) => {
        results.push(n.submission_id);
      });

      const notification: JudgeResultNotification = {
        submission_id: randomUUID(),
        match_id: randomUUID(),
        round_id: randomUUID(),
        user_id: randomUUID(),
        verdict: 'WA',
        passed: 2,
        total: 5,
        exec_time_ms: 80,
      };

      await channel.publishResult(notification);
      expect(results).toEqual([notification.submission_id]);
    });
  });

  describe('JudgmentService', () => {
    async function setupService() {
      const submissionRepo = new InMemorySubmissionRepository();
      const resultChannel = new InMemoryResultChannel();
      const service = new JudgmentService({
        submissionRepo,
        resultPublisher: resultChannel,
      });

      const submission = await submissionRepo.createSubmission({
        match_id: randomUUID(),
        round_id: randomUUID(),
        user_id: randomUUID(),
        problem_id: randomUUID(),
        language: 'python',
        source_code: 'print(1)',
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        admission_seq: 1,
        status: 'queued',
      });

      return { submissionRepo, resultChannel, service, submission };
    }

    it('aplica exitosamente un resultado durable AC y publica notificación', async () => {
      const { service, submissionRepo, resultChannel, submission } = await setupService();

      const durableResult: JudgeDurableResult = {
        submission_id: submission.id,
        verdict: 'AC',
        passed: 12,
        total: 12,
        exec_time_ms: 145,
        judged_at: Date.now(),
        compile_output: 'Compiled successfully',
      };

      const result = await service.applyDurableResult(durableResult, 'req-abc');

      expect(result.isDuplicate).toBe(false);
      expect(result.submission.status).toBe('completed');
      expect(result.submission.verdict).toBe('AC');
      expect(result.submission.passed_cases).toBe(12);
      expect(result.submission.total_cases).toBe(12);
      expect(result.submission.exec_time_ms).toBe(145);
      expect(result.submission.compile_output).toBe('Compiled successfully');

      // Notificación construida correctamente
      expect(result.notification.verdict).toBe('AC');
      expect(result.notification.request_id).toBe('req-abc');
      expect(result.notification.match_id).toBe(submission.match_id);

      // Verificado en canal pub/sub
      const history = resultChannel.getPublishedHistory();
      expect(history).toHaveLength(1);
      expect(history[0]?.submission_id).toBe(submission.id);

      // Verificado en persistencia
      const persisted = await submissionRepo.findSubmissionById(submission.id);
      expect(persisted?.status).toBe('completed');
      expect(persisted?.verdict).toBe('AC');
    });

    it('rechaza con 400 si el resultado durable no cumple invariantes', async () => {
      const { service, submission } = await setupService();

      // passed > total es inválido
      const invalidResult = {
        submission_id: submission.id,
        verdict: 'AC' as const,
        passed: 15,
        total: 10,
        exec_time_ms: 50,
        judged_at: Date.now(),
      };

      await expect(service.applyDurableResult(invalidResult)).rejects.toThrow(HttpError);
    });

    it('rechaza con 404 si el envío no existe', async () => {
      const { service } = await setupService();

      const result: JudgeDurableResult = {
        submission_id: randomUUID(),
        verdict: 'WA',
        passed: 0,
        total: 5,
        exec_time_ms: 20,
        judged_at: Date.now(),
      };

      await expect(service.applyDurableResult(result)).rejects.toThrow(HttpError);
    });

    it('invariante de recuperación: ignora resultados duplicados sin sobreescribir el veredicto (doc 04 § 130, § 140)', async () => {
      const { service, submission } = await setupService();

      const initialResult: JudgeDurableResult = {
        submission_id: submission.id,
        verdict: 'AC',
        passed: 10,
        total: 10,
        exec_time_ms: 100,
        judged_at: Date.now(),
      };

      const first = await service.applyDurableResult(initialResult);
      expect(first.isDuplicate).toBe(false);
      expect(first.submission.verdict).toBe('AC');

      // Intentar sobreescribir con un veredicto posterior (p. ej. worker antiguo tras reclamación)
      const duplicateResult: JudgeDurableResult = {
        submission_id: submission.id,
        verdict: 'WA',
        passed: 5,
        total: 10,
        exec_time_ms: 300,
        judged_at: Date.now() + 5000,
      };

      const second = await service.applyDurableResult(duplicateResult);
      expect(second.isDuplicate).toBe(true);
      // El veredicto original AC se preserva intacto
      expect(second.submission.verdict).toBe('AC');
      expect(second.submission.passed_cases).toBe(10);
    });
  });
});
