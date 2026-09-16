"""Coordinación pura de una entrada del stream con lease, fencing y ACK seguro."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol

from judge.pipeline import DurableJudgeResult, JudgeJob
from judge.stream_codec import MalformedJobError, decode_stream_fields


class ClaimStatus(StrEnum):
    ACQUIRED = "acquired"
    COMPLETED = "completed"
    BUSY = "busy"


@dataclass(frozen=True)
class ClaimResult:
    status: ClaimStatus
    attempt_token: str | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.status, ClaimStatus):
            raise ValueError("Estado de lease inválido")
        if self.status == ClaimStatus.ACQUIRED:
            if not isinstance(self.attempt_token, str) or not self.attempt_token:
                raise ValueError("Un lease adquirido requiere attempt_token")
        elif self.attempt_token is not None:
            raise ValueError("Solo un lease adquirido puede incluir attempt_token")


class PersistStatus(StrEnum):
    STORED = "stored"
    COMPLETED = "completed"
    FENCED = "fenced"


class EntryDisposition(StrEnum):
    ACK_RESULT = "ack_result"
    ACK_DUPLICATE = "ack_duplicate"
    ACK_REJECTED = "ack_rejected"
    RETRY = "retry"


@dataclass(frozen=True)
class EntryOutcome:
    disposition: EntryDisposition
    submission_id: str | None = None
    result: DurableJudgeResult | None = None
    reason: str | None = None

    @property
    def should_ack(self) -> bool:
        return self.disposition != EntryDisposition.RETRY


class JobProcessor(Protocol):
    def process(self, job: JudgeJob) -> DurableJudgeResult: ...


class ResultRepository(Protocol):
    """Persistencia con lease y UPDATE cercado por attempt_token."""

    def claim(self, job: JudgeJob, worker_id: str) -> ClaimResult: ...

    def persist_if_current(
        self, result: DurableJudgeResult, attempt_token: str
    ) -> PersistStatus: ...


class RejectedEntryRepository(Protocol):
    """Aísla el id y motivo saneado de un mensaje que no puede asociarse con seguridad."""

    def record_rejected(self, message_id: str, reason: str) -> bool: ...


class StreamEntryCoordinator:
    """Decide el ACK sin acceder directamente a Redis."""

    def __init__(
        self,
        worker_id: str,
        processor: JobProcessor,
        results: ResultRepository,
        rejected: RejectedEntryRepository,
    ) -> None:
        if not isinstance(worker_id, str) or not worker_id:
            raise ValueError("worker_id es obligatorio")
        self._worker_id = worker_id
        self._processor = processor
        self._results = results
        self._rejected = rejected

    def handle(self, message_id: str, fields: Mapping[Any, Any]) -> EntryOutcome:
        if not isinstance(message_id, str) or not message_id:
            return EntryOutcome(EntryDisposition.RETRY, reason="Id de mensaje inválido")
        try:
            job = decode_stream_fields(fields)
        except MalformedJobError as error:
            reason = str(error)
            try:
                recorded = self._rejected.record_rejected(message_id, reason)
            except Exception:
                recorded = False
            return EntryOutcome(
                EntryDisposition.ACK_REJECTED if recorded else EntryDisposition.RETRY,
                reason=reason if recorded else "No se pudo aislar el mensaje rechazado",
            )

        try:
            claim = self._results.claim(job, self._worker_id)
        except Exception:
            return EntryOutcome(
                EntryDisposition.RETRY,
                submission_id=job.submission_id,
                reason="No se pudo adquirir el lease",
            )
        if claim.status == ClaimStatus.COMPLETED:
            return EntryOutcome(EntryDisposition.ACK_DUPLICATE, submission_id=job.submission_id)
        if claim.status == ClaimStatus.BUSY:
            return EntryOutcome(
                EntryDisposition.RETRY,
                submission_id=job.submission_id,
                reason="El envío tiene otro intento vigente",
            )

        assert claim.attempt_token is not None
        try:
            result = self._processor.process(job)
            persisted = self._results.persist_if_current(result, claim.attempt_token)
        except Exception:
            return EntryOutcome(
                EntryDisposition.RETRY,
                submission_id=job.submission_id,
                reason="El procesamiento o guardado no se completó",
            )
        if persisted == PersistStatus.STORED:
            return EntryOutcome(
                EntryDisposition.ACK_RESULT,
                submission_id=job.submission_id,
                result=result,
            )
        if persisted == PersistStatus.COMPLETED:
            return EntryOutcome(EntryDisposition.ACK_DUPLICATE, submission_id=job.submission_id)
        return EntryOutcome(
            EntryDisposition.RETRY,
            submission_id=job.submission_id,
            reason="El intento perdió el fencing antes de persistir",
        )
