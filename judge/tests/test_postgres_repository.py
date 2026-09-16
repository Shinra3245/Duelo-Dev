"""Pruebas de las decisiones del adaptador PostgreSQL del worker."""

from dataclasses import dataclass, field
from typing import Any

import pytest

from judge.pipeline import DurableJudgeResult, JudgeJob
from judge.postgres_repository import (
    MAX_REJECTION_REASON_CHARS,
    PostgresRejectedEntryRepository,
    PostgresRepositoryError,
    PostgresResultRepository,
)
from judge.verdicts import Verdict
from judge.worker import ClaimStatus, PersistStatus


def job() -> JudgeJob:
    return JudgeJob(
        schema_version=1,
        submission_id="00000000-0000-0000-0000-000000000005",
        problem_id="00000000-0000-0000-0000-000000000002",
        problem_version=3,
        language="python",
        source_code="print(input())",
        time_limit_ms=6000,
        memory_limit_mb=256,
        cases_ref="problem/version-3",
        enqueued_at_ms=1_700_000_000_000,
    )


RESULT = DurableJudgeResult(
    job().submission_id,
    Verdict.AC,
    12,
    12,
    321,
    1_700_000_000_500,
)


def durable_state(status: str) -> tuple[object, ...]:
    received = job()
    return (
        status,
        received.problem_id,
        received.problem_version,
        received.language,
        received.source_code,
        received.time_limit_ms,
        received.memory_limit_mb,
        None,
    )


@dataclass
class ScriptedDatabase:
    responses: list[tuple[object, ...] | None]
    error: Exception | None = None
    calls: list[tuple[str, tuple[object, ...]]] = field(default_factory=list)

    def connect(self) -> "FakeConnection":
        return FakeConnection(self)


class FakeConnection:
    def __init__(self, database: ScriptedDatabase) -> None:
        self.database = database

    def __enter__(self) -> "FakeConnection":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def cursor(self) -> "FakeCursor":
        return FakeCursor(self.database)


class FakeCursor:
    def __init__(self, database: ScriptedDatabase) -> None:
        self.database = database
        self.response: tuple[object, ...] | None = None

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def execute(self, query: str, params: tuple[object, ...]) -> None:
        if self.database.error:
            raise self.database.error
        self.database.calls.append((query, params))
        self.response = self.database.responses.pop(0) if self.database.responses else None

    def fetchone(self) -> tuple[object, ...] | None:
        return self.response


def test_claim_acquires_atomically_with_explicit_lease_and_durable_fields() -> None:
    database = ScriptedDatabase([("a" * 64,)])
    repository = PostgresResultRepository(database.connect, lease_duration_ms=120_000)

    claimed = repository.claim(job(), "worker-1")

    assert claimed.status == ClaimStatus.ACQUIRED
    assert claimed.attempt_token == "a" * 64
    assert len(database.calls) == 1
    params = database.calls[0][1]
    assert params[1:] == (
        "worker-1",
        120_000,
        job().submission_id,
        job().problem_id,
        3,
        "python",
        "print(input())",
        6000,
        256,
    )
    assert len(str(params[0])) == 64


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        ("judging", ClaimStatus.BUSY),
        ("queued", ClaimStatus.BUSY),
        ("completed", ClaimStatus.COMPLETED),
    ],
)
def test_claim_classifies_non_acquired_submission(status: str, expected: ClaimStatus) -> None:
    database = ScriptedDatabase([None, durable_state(status)])

    claimed = PostgresResultRepository(database.connect, lease_duration_ms=120_000).claim(
        job(), "worker-2"
    )

    assert claimed.status == expected
    assert claimed.attempt_token is None


def test_claim_rejects_stream_payload_that_differs_from_durable_submission() -> None:
    mismatched = list(durable_state("queued"))
    mismatched[4] = "print('different')"
    database = ScriptedDatabase([None, tuple(mismatched)])

    with pytest.raises(PostgresRepositoryError, match="no coincide"):
        PostgresResultRepository(database.connect, lease_duration_ms=120_000).claim(
            job(), "worker-1"
        )


def test_database_exception_is_replaced_with_sanitized_claim_error() -> None:
    database = ScriptedDatabase([], error=RuntimeError("postgres://secret@db"))

    with pytest.raises(PostgresRepositoryError) as captured:
        PostgresResultRepository(database.connect, lease_duration_ms=120_000).claim(
            job(), "worker-1"
        )

    assert "secret" not in str(captured.value)


@pytest.mark.parametrize(("response", "expected"), [((job().submission_id,), True), (None, False)])
def test_renew_is_fenced_by_worker_and_attempt(
    response: tuple[object, ...] | None, expected: bool
) -> None:
    database = ScriptedDatabase([response])
    repository = PostgresResultRepository(database.connect, lease_duration_ms=120_000)

    assert repository.renew(job(), "worker-1", "attempt-current") is expected
    assert database.calls[0][1] == (
        120_000,
        job().submission_id,
        "worker-1",
        "attempt-current",
    )


@pytest.mark.parametrize(
    ("responses", "expected"),
    [
        ([(job().submission_id,)], PersistStatus.STORED),
        ([None, ("completed",)], PersistStatus.COMPLETED),
        ([None, ("judging",)], PersistStatus.FENCED),
        ([None, ("queued",)], PersistStatus.FENCED),
    ],
)
def test_persist_is_fenced_and_idempotent(
    responses: list[tuple[object, ...] | None], expected: PersistStatus
) -> None:
    database = ScriptedDatabase(responses)
    repository = PostgresResultRepository(database.connect, lease_duration_ms=120_000)

    assert repository.persist_if_current(RESULT, "attempt-current") == expected
    params = database.calls[0][1]
    assert params == (
        "AC",
        12,
        12,
        321,
        None,
        None,
        1_700_000_000_500,
        job().submission_id,
        "attempt-current",
    )


def test_rejected_message_insert_and_duplicate_both_allow_ack() -> None:
    database = ScriptedDatabase([None, None])
    repository = PostgresRejectedEntryRepository(database.connect)

    assert repository.record_rejected("1700000000000-0", "campo inválido")
    assert repository.record_rejected("1700000000000-0", "campo inválido")
    assert len(database.calls) == 2


def test_rejected_reason_is_bounded_and_invalid_identifier_is_not_written() -> None:
    database = ScriptedDatabase([None])
    repository = PostgresRejectedEntryRepository(database.connect)

    assert repository.record_rejected("1-0", "x" * 2000)
    assert len(str(database.calls[0][1][1])) == MAX_REJECTION_REASON_CHARS
    assert not repository.record_rejected("x" * 129, "motivo")
    assert len(database.calls) == 1


def test_rejected_storage_failure_does_not_allow_ack() -> None:
    database = ScriptedDatabase([], error=RuntimeError("database unavailable"))

    assert not PostgresRejectedEntryRepository(database.connect).record_rejected("1-0", "motivo")


@pytest.mark.parametrize("lease_duration_ms", [0, -1, 1.5, True])
def test_lease_duration_must_be_a_positive_integer(lease_duration_ms: Any) -> None:
    with pytest.raises(ValueError, match="positivo"):
        PostgresResultRepository(ScriptedDatabase([]).connect, lease_duration_ms=lease_duration_ms)
