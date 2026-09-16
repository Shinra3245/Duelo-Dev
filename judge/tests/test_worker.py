"""El coordinador solo habilita ACK después de una decisión durable."""

from dataclasses import dataclass, field

import pytest

from judge.pipeline import DurableJudgeResult, JudgeJob
from judge.stream_codec import encode_stream_fields
from judge.verdicts import Verdict
from judge.worker import (
    ClaimResult,
    ClaimStatus,
    EntryDisposition,
    PersistStatus,
    StreamEntryCoordinator,
)


def job() -> JudgeJob:
    return JudgeJob(
        schema_version=1,
        submission_id="submission-1",
        problem_id="problem-1",
        problem_version=1,
        language="cpp",
        source_code="private source",
        time_limit_ms=1000,
        memory_limit_mb=256,
        cases_ref="cases/problem-1",
        enqueued_at_ms=1_700_000_000_000,
    )


RESULT = DurableJudgeResult("submission-1", Verdict.AC, 1, 1, 5, 1_700_000_000_100)


@dataclass
class FakeProcessor:
    result: DurableJudgeResult = RESULT
    error: Exception | None = None
    calls: int = 0

    def process(self, received: JudgeJob) -> DurableJudgeResult:
        self.calls += 1
        if self.error:
            raise self.error
        return self.result


@dataclass
class SequenceProcessor:
    results: list[DurableJudgeResult]
    calls: int = 0

    def process(self, received: JudgeJob) -> DurableJudgeResult:
        result = self.results[self.calls]
        self.calls += 1
        return result


@dataclass
class FakeResults:
    claim_result: ClaimResult = ClaimResult(ClaimStatus.ACQUIRED, "attempt-1")
    persist_status: PersistStatus = PersistStatus.STORED
    claim_error: Exception | None = None
    persist_error: Exception | None = None
    persisted_tokens: list[str] = field(default_factory=list)

    def claim(self, received: JudgeJob, worker_id: str) -> ClaimResult:
        if self.claim_error:
            raise self.claim_error
        return self.claim_result

    def persist_if_current(self, result: DurableJudgeResult, attempt_token: str) -> PersistStatus:
        self.persisted_tokens.append(attempt_token)
        if self.persist_error:
            raise self.persist_error
        return self.persist_status


@dataclass
class FakeRejected:
    recorded: bool = True
    error: Exception | None = None
    entries: list[tuple[str, str]] = field(default_factory=list)

    def record_rejected(self, message_id: str, reason: str) -> bool:
        self.entries.append((message_id, reason))
        if self.error:
            raise self.error
        return self.recorded


def coordinator(
    *,
    processor: FakeProcessor | None = None,
    results: FakeResults | None = None,
    rejected: FakeRejected | None = None,
) -> tuple[StreamEntryCoordinator, FakeProcessor, FakeResults, FakeRejected]:
    actual_processor = processor or FakeProcessor()
    actual_results = results or FakeResults()
    actual_rejected = rejected or FakeRejected()
    return (
        StreamEntryCoordinator("worker-1", actual_processor, actual_results, actual_rejected),
        actual_processor,
        actual_results,
        actual_rejected,
    )


def test_stored_result_enables_ack_and_uses_attempt_token() -> None:
    subject, processor, results, _ = coordinator()

    outcome = subject.handle("1-0", encode_stream_fields(job()))

    assert outcome.disposition == EntryDisposition.ACK_RESULT
    assert outcome.should_ack
    assert outcome.result == RESULT
    assert results.persisted_tokens == ["attempt-1"]
    assert processor.calls == 1


def test_system_error_is_retried_once_inside_the_same_lease() -> None:
    first = DurableJudgeResult(
        "submission-1", Verdict.SE, 0, 1, 0, 1_700_000_000_100, judge_error="first"
    )
    processor = SequenceProcessor([first, RESULT])
    results = FakeResults()
    subject = StreamEntryCoordinator("worker-1", processor, results, FakeRejected())

    outcome = subject.handle("1-0", encode_stream_fields(job()))

    assert processor.calls == 2
    assert outcome.disposition == EntryDisposition.ACK_RESULT
    assert outcome.result == RESULT
    assert results.persisted_tokens == ["attempt-1"]


def test_second_system_error_is_persisted_as_definitive() -> None:
    first = DurableJudgeResult(
        "submission-1", Verdict.SE, 0, 1, 0, 1_700_000_000_100, judge_error="first"
    )
    second = DurableJudgeResult(
        "submission-1", Verdict.SE, 0, 1, 0, 1_700_000_000_200, judge_error="second"
    )
    processor = SequenceProcessor([first, second])
    results = FakeResults()
    subject = StreamEntryCoordinator("worker-1", processor, results, FakeRejected())

    outcome = subject.handle("1-0", encode_stream_fields(job()))

    assert processor.calls == 2
    assert outcome.result == second
    assert outcome.result.judge_error == "second"
    assert results.persisted_tokens == ["attempt-1"]


def test_completed_duplicate_acks_without_running_again() -> None:
    processor = FakeProcessor()
    subject, _, _, _ = coordinator(
        processor=processor,
        results=FakeResults(claim_result=ClaimResult(ClaimStatus.COMPLETED)),
    )

    outcome = subject.handle("1-0", encode_stream_fields(job()))

    assert outcome.disposition == EntryDisposition.ACK_DUPLICATE
    assert outcome.should_ack
    assert processor.calls == 0


def test_busy_or_fenced_attempt_remains_pending() -> None:
    busy, processor, _, _ = coordinator(
        results=FakeResults(claim_result=ClaimResult(ClaimStatus.BUSY))
    )
    busy_outcome = busy.handle("1-0", encode_stream_fields(job()))
    assert busy_outcome.disposition == EntryDisposition.RETRY
    assert not busy_outcome.should_ack
    assert processor.calls == 0

    fenced, _, _, _ = coordinator(results=FakeResults(persist_status=PersistStatus.FENCED))
    fenced_outcome = fenced.handle("1-0", encode_stream_fields(job()))
    assert fenced_outcome.disposition == EntryDisposition.RETRY
    assert not fenced_outcome.should_ack


@pytest.mark.parametrize("stage", ["claim", "process", "persist"])
def test_transient_failures_never_ack(stage: str) -> None:
    processor = FakeProcessor(error=RuntimeError("source secret")) if stage == "process" else None
    results = FakeResults(
        claim_error=RuntimeError("db") if stage == "claim" else None,
        persist_error=RuntimeError("db") if stage == "persist" else None,
    )
    subject, _, _, _ = coordinator(processor=processor, results=results)

    outcome = subject.handle("1-0", encode_stream_fields(job()))

    assert outcome.disposition == EntryDisposition.RETRY
    assert not outcome.should_ack
    assert "secret" not in (outcome.reason or "")


def test_malformed_entry_acks_only_after_durable_isolation() -> None:
    malformed = encode_stream_fields(job())
    malformed["source_path"] = "/private/path"
    rejected = FakeRejected()
    subject, processor, _, _ = coordinator(rejected=rejected)

    outcome = subject.handle("2-0", malformed)

    assert outcome.disposition == EntryDisposition.ACK_REJECTED
    assert outcome.should_ack
    assert processor.calls == 0
    assert rejected.entries and rejected.entries[0][0] == "2-0"
    assert "/private/path" not in rejected.entries[0][1]


@pytest.mark.parametrize("raises", [False, True])
def test_malformed_entry_stays_pending_if_isolation_fails(raises: bool) -> None:
    malformed = encode_stream_fields(job())
    malformed.pop("problem_id")
    rejected = FakeRejected(recorded=False, error=RuntimeError("storage") if raises else None)
    subject, _, _, _ = coordinator(rejected=rejected)

    outcome = subject.handle("2-0", malformed)

    assert outcome.disposition == EntryDisposition.RETRY
    assert not outcome.should_ack


def test_invalid_message_id_is_not_acked_or_recorded() -> None:
    subject, _, _, rejected = coordinator()

    outcome = subject.handle("", encode_stream_fields(job()))

    assert outcome.disposition == EntryDisposition.RETRY
    assert rejected.entries == []


def test_claim_invariants_reject_tokens_in_wrong_state() -> None:
    with pytest.raises(ValueError, match="requiere"):
        ClaimResult(ClaimStatus.ACQUIRED)
    with pytest.raises(ValueError, match="Solo"):
        ClaimResult(ClaimStatus.BUSY, "token")
    with pytest.raises(ValueError, match="Estado"):
        ClaimResult("busy")  # type: ignore[arg-type]
