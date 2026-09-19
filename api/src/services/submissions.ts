import { createHash } from 'node:crypto';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  IDEMPOTENCY_WINDOW_S,
  JUDGE_STREAM_SCHEMA_VERSION,
  createLogger,
  resolveTimeLimitMs,
  type CreateSubmissionRequest,
  type JudgeJobStreamMessage,
  type Logger,
  type ProblemPublicResponse,
  type SubmissionAcceptedResponse,
  type SubmissionDetailsResponse,
} from '@duelodev/shared';
import { HttpError } from '../plugins/body-parser.js';
import type {
  ProblemRepository,
  RoomRepository,
  SubmissionRepository,
} from '../repositories/types.js';
import type { JudgeQueue } from '../queue/types.js';
import type { AuditService } from './audit.js';

/** Cooldown por defecto entre envíos por jugador en una partida (10 segundos, doc 04 §2). */
export const SUBMISSION_COOLDOWN_S = 10;

interface IdempotencyRecord {
  bodyHash: string;
  response: SubmissionAcceptedResponse;
  expiresAt: number;
}

export interface SubmissionServiceOptions {
  submissionRepo: SubmissionRepository;
  roomRepo: RoomRepository;
  problemRepo?: ProblemRepository | undefined;
  judgeQueue?: JudgeQueue | undefined;
  logger?: Logger | undefined;
  cooldownSeconds?: number;
  idempotencyWindowSeconds?: number;
  auditService?: AuditService | undefined;
}

/**
 * Servicio de admisión durable de envíos, control de cooldown, idempotencia y consulta (doc 04 §2).
 */
export class SubmissionService {
  private readonly submissionRepo: SubmissionRepository;
  private readonly roomRepo: RoomRepository;
  private readonly problemRepo?: ProblemRepository | undefined;
  private readonly judgeQueue?: JudgeQueue | undefined;
  private readonly logger: Logger;
  private readonly cooldownSeconds: number;
  private readonly idempotencyWindowSeconds: number;
  private readonly auditService?: AuditService | undefined;

  /** Registro de idempotencia en memoria: `${userId}:${endpoint}:${key}` -> record */
  private readonly idempotencyRecords = new Map<string, IdempotencyRecord>();
  /** Registro de cooldown en memoria: `${matchId}:${userId}` -> timestamp_ms */
  private readonly cooldowns = new Map<string, number>();
  /** Registro de envíos activos en vuelo para serialización concurrente atómica */
  private readonly activeSubmissions = new Set<string>();

  constructor(options: SubmissionServiceOptions) {
    this.submissionRepo = options.submissionRepo;
    this.roomRepo = options.roomRepo;
    this.problemRepo = options.problemRepo;
    this.judgeQueue = options.judgeQueue;
    this.logger = options.logger ?? createLogger('submission-service');
    this.cooldownSeconds = options.cooldownSeconds ?? SUBMISSION_COOLDOWN_S;
    this.idempotencyWindowSeconds = options.idempotencyWindowSeconds ?? IDEMPOTENCY_WINDOW_S;
    this.auditService = options.auditService;
  }

  /**
   * Procesa la admisión durable de un envío con control de idempotencia y cooldown (doc 04 §2).
   */
  async submit(
    userId: string,
    req: CreateSubmissionRequest,
    idempotencyKey?: string | null,
    now: number = Date.now(),
    requestId?: string,
  ): Promise<{ response: SubmissionAcceptedResponse; retryAfter?: number }> {
    const rawBodyJson = JSON.stringify(req);
    const bodyHash = createHash('sha256').update(rawBodyJson, 'utf8').digest('hex');

    // 1. Verificar clave de idempotencia antes del cooldown (doc 04 §2)
    let idempotencyStorageKey: string | undefined;
    if (idempotencyKey) {
      idempotencyStorageKey = `${userId}:POST /submissions:${idempotencyKey}`;
      const existing = this.idempotencyRecords.get(idempotencyStorageKey);

      if (existing && existing.expiresAt > now) {
        if (existing.bodyHash === bodyHash) {
          // Misma clave y mismo cuerpo -> mismo id, sin consumir cooldown otra vez
          return { response: existing.response };
        } else {
          // Misma clave y cuerpo distinto -> 409 CONFLICT (doc 04 §2)
          throw new HttpError(
            409,
            ERROR_CODES.CONFLICT,
            'La clave de idempotencia ya fue usada con un cuerpo de solicitud diferente.',
          );
        }
      }
    }

    const matchBeforeCooldown = await this.roomRepo.findMatchById(req.match_id);
    if (
      matchBeforeCooldown?.instructions_ends_at &&
      Date.parse(matchBeforeCooldown.instructions_ends_at) > now
    ) {
      throw new HttpError(
        409,
        ERROR_CODES.MATCH_INSTRUCTIONS_ACTIVE,
        ERROR_MESSAGES.MATCH_INSTRUCTIONS_ACTIVE,
      );
    }

    // 2. Control de cooldown por jugador en la partida (10 s) y reserva atómica (doc 04 §2)
    const cooldownKey = `${req.match_id}:${userId}`;
    const lastSubmitted = this.cooldowns.get(cooldownKey);
    const cooldownDurationMs = this.cooldownSeconds * 1000;

    if (this.activeSubmissions.has(cooldownKey)) {
      throw new HttpError(429, ERROR_CODES.SUBMIT_COOLDOWN, ERROR_MESSAGES.SUBMIT_COOLDOWN, {
        retry_after_s: this.cooldownSeconds,
      });
    }

    if (lastSubmitted && now < lastSubmitted + cooldownDurationMs) {
      const remainingMs = lastSubmitted + cooldownDurationMs - now;
      const retryAfterSeconds = Math.ceil(remainingMs / 1000);
      throw new HttpError(429, ERROR_CODES.SUBMIT_COOLDOWN, ERROR_MESSAGES.SUBMIT_COOLDOWN, {
        retry_after_s: retryAfterSeconds,
      });
    }

    // Reservar cooldown slot inmediatamente para serializar peticiones concurrentes
    this.activeSubmissions.add(cooldownKey);
    this.cooldowns.set(cooldownKey, now);

    try {
      // 3. Verificar existencia y estado de la partida
      const match = await this.roomRepo.findMatchById(req.match_id);
      if (!match) {
        throw new HttpError(404, ERROR_CODES.ROOM_NOT_FOUND, ERROR_MESSAGES.ROOM_NOT_FOUND);
      }

      if (match.status !== 'running') {
        throw new HttpError(409, ERROR_CODES.CONFLICT, 'La partida no está en curso.');
      }
      if (match.instructions_ends_at && Date.parse(match.instructions_ends_at) > now) {
        throw new HttpError(
          409,
          ERROR_CODES.MATCH_INSTRUCTIONS_ACTIVE,
          ERROR_MESSAGES.MATCH_INSTRUCTIONS_ACTIVE,
        );
      }

      // 4. Verificar que el usuario sea un jugador elegible de la partida
      const player = await this.roomRepo.findPlayer(req.match_id, userId);
      if (!player) {
        throw new HttpError(403, ERROR_CODES.NOT_A_PLAYER, ERROR_MESSAGES.NOT_A_PLAYER);
      }

      // 5. Asignar secuencia de admisión atómica para la partida
      let nextAdmissionSeq: number;
      if (this.roomRepo.allocateNextAdmissionSeq) {
        nextAdmissionSeq = await this.roomRepo.allocateNextAdmissionSeq(match.id);
      } else {
        nextAdmissionSeq = (match.admission_seq ?? 0) + 1;
        await this.roomRepo.updateMatch(match.id, { admission_seq: nextAdmissionSeq });
      }

      // 6. Obtener límites de tiempo/memoria y versión del problema si existe
      let baseTimeLimitMs = 2000;
      let memoryLimitMb = 256;
      let problemVersion = 1;
      if (this.problemRepo) {
        const prob = await this.problemRepo.findProblemById(req.problem_id);
        if (prob) {
          baseTimeLimitMs = prob.time_limit_ms;
          memoryLimitMb = prob.memory_limit_mb;
          problemVersion = prob.version ?? 1;
        }
      }
      const effectiveTimeLimitMs = resolveTimeLimitMs(baseTimeLimitMs, req.language);

      // 7. Persistir el envío de forma durable
      const submission = await this.submissionRepo.createSubmission({
        match_id: req.match_id,
        round_id: req.round_id,
        user_id: userId,
        problem_id: req.problem_id,
        language: req.language,
        source_code: req.source_code,
        time_limit_ms: effectiveTimeLimitMs,
        memory_limit_mb: memoryLimitMb,
        admission_seq: nextAdmissionSeq,
        status: 'queued',
      });

      if (this.auditService) {
        await this.auditService.recordSubmission(
          submission.id,
          submission.match_id,
          submission.round_id,
          submission.user_id,
          submission.problem_id,
          submission.language,
        );
      }

      const acceptedResponse: SubmissionAcceptedResponse = {
        submission_id: submission.id,
        match_id: submission.match_id,
        round_id: submission.round_id,
        problem_id: submission.problem_id,
        admission_seq: submission.admission_seq,
        received_at: new Date(submission.received_at).getTime(),
        status: 'queued',
      };

      // Guardar registro de idempotencia si la clave fue provista
      if (idempotencyStorageKey) {
        this.idempotencyRecords.set(idempotencyStorageKey, {
          bodyHash,
          response: acceptedResponse,
          expiresAt: now + this.idempotencyWindowSeconds * 1000,
        });
      }

      // 8. Despachar a la cola judge:stream (doc 04 §4)
      if (this.judgeQueue) {
        const casesRef = `cases/${req.problem_id}`;
        const jobMessage: JudgeJobStreamMessage = {
          schema_version: JUDGE_STREAM_SCHEMA_VERSION,
          submission_id: submission.id,
          problem_id: req.problem_id,
          problem_version: problemVersion,
          language: req.language,
          source_code: req.source_code,
          time_limit_ms: effectiveTimeLimitMs,
          memory_limit_mb: memoryLimitMb,
          cases_ref: casesRef,
          enqueued_at_ms: now,
          ...(requestId ? { request_id: requestId } : {}),
        };

        try {
          await this.judgeQueue.enqueue(jobMessage);
        } catch (queueErr) {
          this.logger.warn(
            'Fallo transitorio al encolar en judge:stream; la reconciliación recuperará el envío',
            {
              submission_id: submission.id,
              error: queueErr instanceof Error ? queueErr.message : String(queueErr),
            },
          );
        }
      }

      return { response: acceptedResponse };
    } finally {
      this.activeSubmissions.delete(cooldownKey);
    }
  }

  /**
   * Obtiene los detalles de un envío para su dueño sin revelar casos ocultos (doc 04 §2).
   */
  async getSubmissionDetails(
    submissionId: string,
    requestingUserId: string,
  ): Promise<SubmissionDetailsResponse> {
    const submission = await this.submissionRepo.findSubmissionById(submissionId);
    if (!submission) {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, ERROR_MESSAGES.NOT_FOUND);
    }

    // Restricción de dueño: solo el autor puede consultar el envío
    if (submission.user_id !== requestingUserId) {
      throw new HttpError(403, ERROR_CODES.FORBIDDEN, ERROR_MESSAGES.FORBIDDEN);
    }

    return {
      submission_id: submission.id,
      match_id: submission.match_id,
      round_id: submission.round_id,
      problem_id: submission.problem_id,
      language: submission.language,
      status: submission.status,
      verdict: submission.verdict,
      passed: submission.passed_cases,
      total: submission.total_cases,
      exec_time_ms: submission.exec_time_ms,
      ...(submission.compile_output ? { compile_output: submission.compile_output } : {}),
      received_at: new Date(submission.received_at).getTime(),
      ...(submission.judged_at ? { judged_at: new Date(submission.judged_at).getTime() } : {}),
    };
  }

  /**
   * Obtiene el enunciado y ejemplos públicos de un problema (doc 04 §2).
   * Nunca incluye casos de prueba ocultos.
   */
  async getProblemPublic(problemId: string): Promise<ProblemPublicResponse> {
    if (!this.problemRepo) {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, ERROR_MESSAGES.NOT_FOUND);
    }

    const problem = await this.problemRepo.findProblemById(problemId);
    if (!problem) {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, ERROR_MESSAGES.NOT_FOUND);
    }

    const testCases = await this.problemRepo.findTestCasesByProblemId(problemId);
    // Filtrar estrictamente solo casos con is_example: true
    const publicExamples = testCases
      .filter((tc) => tc.is_example)
      .map((tc) => ({
        input: tc.input,
        output: tc.expected_output,
      }));

    return {
      problem_id: problem.id,
      title: problem.title,
      description: problem.description,
      time_limit_ms: problem.time_limit_ms,
      memory_limit_mb: problem.memory_limit_mb,
      examples: publicExamples,
    };
  }
}
