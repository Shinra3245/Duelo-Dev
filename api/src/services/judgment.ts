/**
 * Servicio de ingestión y aplicación de resultados durables del juez (doc 04 §1, §4).
 */
import {
  type JudgeDurableResult,
  type JudgeResultNotification,
  type SubmissionEntity,
  ERROR_CODES,
  createLogger,
  isJudgeDurableResult,
  type Logger,
} from '@duelodev/shared';
import { HttpError } from '../plugins/body-parser.js';
import type { SubmissionRepository } from '../repositories/types.js';
import type { ResultPublisher } from '../queue/results.js';

export interface JudgmentServiceOptions {
  submissionRepo: SubmissionRepository;
  resultPublisher?: ResultPublisher | undefined;
  logger?: Logger | undefined;
}

export interface AppliedJudgment {
  submission: SubmissionEntity;
  notification: JudgeResultNotification;
  isDuplicate: boolean;
}

/**
 * Aplica resultados durables emitidos por el juez, asegura idempotencia y despacha
 * avisos livianos al canal `judge:results` (doc 04 §4).
 */
export class JudgmentService {
  private readonly submissionRepo: SubmissionRepository;
  private readonly resultPublisher?: ResultPublisher | undefined;
  private readonly logger: Logger;

  constructor(options: JudgmentServiceOptions) {
    this.submissionRepo = options.submissionRepo;
    this.resultPublisher = options.resultPublisher;
    this.logger = options.logger ?? createLogger('judgment-service');
  }

  /**
   * Aplica un resultado durable a un envío registrado.
   *
   * Invariantes de recuperación (doc 04 § 130, § 140):
   * - Si el envío ya tiene un veredicto registrado ('completed'), la operación es idempotente
   *   y no sobreescribe el intento original.
   * - Si el resultado no cumple los invariantes de `isJudgeDurableResult`, se rechaza con 400.
   * - Si el envío no existe, se rechaza con 404.
   * - Al persistir exitosamente, emite `JudgeResultNotification` al publicador `judge:results`.
   */
  async applyDurableResult(
    result: JudgeDurableResult,
    requestId?: string,
  ): Promise<AppliedJudgment> {
    if (!isJudgeDurableResult(result)) {
      throw new HttpError(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        'El resultado durable no cumple con los invariantes del contrato JudgeDurableResult.',
      );
    }

    const submission = await this.submissionRepo.findSubmissionById(result.submission_id);
    if (!submission) {
      throw new HttpError(
        404,
        ERROR_CODES.NOT_FOUND,
        `No se encontró el envío con ID ${result.submission_id}`,
      );
    }

    // 1. Control de duplicados y fencing (doc 04 § 130, § 140)
    // Si ya fue completado, devolver el estado existente sin sobreescribir
    if (submission.status === 'completed' && submission.verdict !== null) {
      this.logger.info('Envío ya completado previamente; ignorando resultado duplicado', {
        submission_id: submission.id,
        verdict: submission.verdict,
        ...(requestId !== undefined ? { request_id: requestId } : {}),
      });

      const duplicateNotification: JudgeResultNotification = {
        submission_id: submission.id,
        match_id: submission.match_id,
        round_id: submission.round_id,
        user_id: submission.user_id,
        verdict: submission.verdict,
        passed: submission.passed_cases ?? result.passed,
        total: submission.total_cases ?? result.total,
        exec_time_ms: submission.exec_time_ms ?? result.exec_time_ms,
        ...(requestId ? { request_id: requestId } : {}),
      };

      return {
        submission,
        notification: duplicateNotification,
        isDuplicate: true,
      };
    }

    // 2. Persistir resultado durable en el repositorio
    const updated = await this.submissionRepo.updateSubmission(submission.id, {
      status: 'completed',
      verdict: result.verdict,
      passed_cases: result.passed,
      total_cases: result.total,
      exec_time_ms: result.exec_time_ms,
      compile_output: result.compile_output ?? null,
      judge_error: result.judge_error ?? null,
      judged_at: new Date(result.judged_at).toISOString(),
    });

    if (!updated) {
      throw new HttpError(500, ERROR_CODES.INTERNAL, 'Error al actualizar el estado del envío.');
    }

    // 3. Construir aviso de resultado liviano (doc 04 §4)
    const notification: JudgeResultNotification = {
      submission_id: updated.id,
      match_id: updated.match_id,
      round_id: updated.round_id,
      user_id: updated.user_id,
      verdict: result.verdict,
      passed: result.passed,
      total: result.total,
      exec_time_ms: result.exec_time_ms,
      ...(requestId ? { request_id: requestId } : {}),
    };

    // 4. Publicar aviso en judge:results si el publicador está configurado
    if (this.resultPublisher) {
      try {
        await this.resultPublisher.publishResult(notification);
      } catch (err) {
        // La notificación es at-most-once; el resultado durable ya está guardado (doc 04 §4, § 131)
        this.logger.warn('Fallo al publicar aviso en judge:results tras persistir resultado', {
          submission_id: updated.id,
          error: err instanceof Error ? err.message : String(err),
          ...(requestId !== undefined ? { request_id: requestId } : {}),
        });
      }
    }

    this.logger.info('Resultado durable del juez aplicado exitosamente', {
      submission_id: updated.id,
      match_id: updated.match_id,
      round_id: updated.round_id,
      user_id: updated.user_id,
      verdict: result.verdict,
      passed: result.passed,
      total: result.total,
      exec_time_ms: result.exec_time_ms,
      ...(requestId !== undefined ? { request_id: requestId } : {}),
    });

    return {
      submission: updated,
      notification,
      isDuplicate: false,
    };
  }
}
