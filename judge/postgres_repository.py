"""Persistencia PostgreSQL del worker con lease, fencing e idempotencia."""

from collections.abc import Callable, Sequence
from secrets import token_hex
from typing import Any

from judge.pipeline import DurableJudgeResult, JudgeJob
from judge.worker import ClaimResult, ClaimStatus, PersistStatus


MAX_REJECTION_REASON_CHARS = 1024
MAX_MESSAGE_ID_CHARS = 128
MAX_WORKER_ID_CHARS = 128


class PostgresRepositoryError(RuntimeError):
    """Fallo saneado de persistencia que no expone consultas, datos ni credenciales."""


class PostgresResultRepository:
    """Implementa el claim atómico y el UPDATE cercado de un envío."""

    def __init__(self, connect: Callable[[], Any], *, lease_duration_ms: int) -> None:
        if not callable(connect):
            raise ValueError("connect debe ser invocable")
        if type(lease_duration_ms) is not int or lease_duration_ms < 1:
            raise ValueError("lease_duration_ms debe ser positivo")
        self._connect = connect
        self._lease_duration_ms = lease_duration_ms

    def claim(self, job: JudgeJob, worker_id: str) -> ClaimResult:
        if not isinstance(worker_id, str) or not 1 <= len(worker_id) <= MAX_WORKER_ID_CHARS:
            raise ValueError("worker_id debe tener entre 1 y 128 caracteres")
        attempt_token = token_hex(32)
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        _CLAIM_SQL,
                        (
                            attempt_token,
                            worker_id,
                            self._lease_duration_ms,
                            job.submission_id,
                            job.problem_id,
                            job.problem_version,
                            job.language,
                            job.source_code,
                            job.time_limit_ms,
                            job.memory_limit_mb,
                        ),
                    )
                    acquired = cursor.fetchone()
                    if acquired is not None:
                        return ClaimResult(ClaimStatus.ACQUIRED, str(acquired[0]))

                    cursor.execute(_SUBMISSION_STATE_SQL, (job.submission_id,))
                    state = cursor.fetchone()
                    if state is None:
                        raise PostgresRepositoryError("El envío no existe en PostgreSQL")
                    self._validate_durable_contract(job, state)
                    status = str(state[0])
                    if status == "completed":
                        return ClaimResult(ClaimStatus.COMPLETED)
                    if status in ("queued", "judging"):
                        return ClaimResult(ClaimStatus.BUSY)
                    raise PostgresRepositoryError("El envío tiene un estado durable inválido")
        except PostgresRepositoryError:
            raise
        except Exception:
            raise PostgresRepositoryError("No se pudo reclamar el envío en PostgreSQL") from None

    def renew(self, job: JudgeJob, worker_id: str, attempt_token: str) -> bool:
        if not isinstance(worker_id, str) or not 1 <= len(worker_id) <= MAX_WORKER_ID_CHARS:
            raise ValueError("worker_id debe tener entre 1 y 128 caracteres")
        if not isinstance(attempt_token, str) or not 1 <= len(attempt_token) <= 64:
            raise ValueError("attempt_token debe tener entre 1 y 64 caracteres")
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        _RENEW_SQL,
                        (
                            self._lease_duration_ms,
                            job.submission_id,
                            worker_id,
                            attempt_token,
                        ),
                    )
                    return cursor.fetchone() is not None
        except Exception:
            raise PostgresRepositoryError("No se pudo renovar el lease en PostgreSQL") from None

    def persist_if_current(self, result: DurableJudgeResult, attempt_token: str) -> PersistStatus:
        if not isinstance(attempt_token, str) or not attempt_token:
            raise ValueError("attempt_token es obligatorio")
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        _PERSIST_SQL,
                        (
                            result.verdict.value,
                            result.passed,
                            result.total,
                            result.exec_time_ms,
                            result.compile_output,
                            result.judge_error,
                            result.judged_at,
                            result.submission_id,
                            attempt_token,
                        ),
                    )
                    if cursor.fetchone() is not None:
                        return PersistStatus.STORED

                    cursor.execute(_STATUS_SQL, (result.submission_id,))
                    state = cursor.fetchone()
                    if state is None:
                        raise PostgresRepositoryError("El envío no existe en PostgreSQL")
                    return (
                        PersistStatus.COMPLETED
                        if str(state[0]) == "completed"
                        else PersistStatus.FENCED
                    )
        except PostgresRepositoryError:
            raise
        except Exception:
            raise PostgresRepositoryError("No se pudo guardar el veredicto en PostgreSQL") from None

    @staticmethod
    def _validate_durable_contract(job: JudgeJob, state: Sequence[object]) -> None:
        if len(state) != 8:
            raise PostgresRepositoryError("PostgreSQL devolvió un envío incompleto")
        durable = (
            str(state[1]),
            _database_int(state[2]),
            str(state[3]),
            str(state[4]),
            _database_int(state[5]),
            _database_int(state[6]),
        )
        expected = (
            job.problem_id,
            job.problem_version,
            job.language,
            job.source_code,
            job.time_limit_ms,
            job.memory_limit_mb,
        )
        if durable != expected:
            raise PostgresRepositoryError("El mensaje no coincide con el envío durable")


def _database_int(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise PostgresRepositoryError("PostgreSQL devolvió un entero inválido")
    return value


class PostgresRejectedEntryRepository:
    """Registra mensajes inválidos sin conservar el payload recibido."""

    def __init__(self, connect: Callable[[], Any]) -> None:
        if not callable(connect):
            raise ValueError("connect debe ser invocable")
        self._connect = connect

    def record_rejected(self, message_id: str, reason: str) -> bool:
        if not isinstance(message_id, str) or not 1 <= len(message_id) <= MAX_MESSAGE_ID_CHARS:
            return False
        if not isinstance(reason, str) or not reason:
            return False
        sanitized_reason = reason[:MAX_REJECTION_REASON_CHARS]
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(_RECORD_REJECTED_SQL, (message_id, sanitized_reason))
            # Un INSERT nuevo y un conflicto existente representan el mismo estado durable.
            return True
        except Exception:
            return False


_CLAIM_SQL = """
UPDATE submissions AS submission
SET status = 'judging',
    attempt_token = %s,
    worker_id = %s,
    lease_until = clock_timestamp() + (%s * interval '1 millisecond')
FROM problems AS problem
WHERE submission.id = %s
  AND problem.id = submission.problem_id
  AND submission.problem_id = %s
  AND problem.version = %s
  AND submission.language = %s
  AND submission.source_code = %s
  AND submission.time_limit_ms = %s
  AND submission.memory_limit_mb = %s
  AND (
    submission.status = 'queued'
    OR (submission.status = 'judging' AND submission.lease_until <= clock_timestamp())
  )
RETURNING submission.attempt_token
"""

_SUBMISSION_STATE_SQL = """
SELECT submission.status,
       submission.problem_id,
       problem.version,
       submission.language,
       submission.source_code,
       submission.time_limit_ms,
       submission.memory_limit_mb,
       submission.attempt_token
FROM submissions AS submission
JOIN problems AS problem ON problem.id = submission.problem_id
WHERE submission.id = %s
"""

_PERSIST_SQL = """
UPDATE submissions
SET status = 'completed',
    verdict = %s,
    passed_cases = %s,
    total_cases = %s,
    exec_time_ms = %s,
    compile_output = %s,
    judge_error = %s,
    judged_at = to_timestamp(%s / 1000.0),
    attempt_token = NULL,
    worker_id = NULL,
    lease_until = NULL
WHERE id = %s
  AND status = 'judging'
  AND attempt_token = %s
RETURNING id
"""

_STATUS_SQL = "SELECT status FROM submissions WHERE id = %s"

_RENEW_SQL = """
UPDATE submissions
SET lease_until = clock_timestamp() + (%s * interval '1 millisecond')
WHERE id = %s
  AND status = 'judging'
  AND worker_id = %s
  AND attempt_token = %s
RETURNING id
"""

_RECORD_REJECTED_SQL = """
INSERT INTO judge_rejected_messages (message_id, reason)
VALUES (%s, %s)
ON CONFLICT (message_id) DO NOTHING
"""
