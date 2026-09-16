"""El aviso Redis se reconstruye desde PostgreSQL y nunca desde el stream."""

import json
from dataclasses import dataclass, field

import pytest

from judge.pipeline import DurableJudgeResult
from judge.result_notification import PostgresRedisResultNotifier, ResultNotificationError
from judge.verdicts import Verdict
from judge.worker import EntryDisposition, EntryOutcome


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


RESULT = DurableJudgeResult(
    "00000000-0000-0000-0000-000000000005",
    Verdict.AC,
    12,
    12,
    321,
    1_700_000_000_500,
)
OUTCOME = EntryOutcome(EntryDisposition.ACK_RESULT, RESULT.submission_id, RESULT)
ROW = (
    RESULT.submission_id,
    "00000000-0000-0000-0000-000000000003",
    "00000000-0000-0000-0000-000000000004",
    "00000000-0000-0000-0000-000000000001",
    "AC",
    12,
    12,
    321,
    "completed",
)


def test_publishes_compact_notification_rebuilt_from_completed_row() -> None:
    database = ScriptedDatabase([ROW])
    published: list[tuple[str, str]] = []
    notifier = PostgresRedisResultNotifier(
        database.connect, lambda channel, payload: published.append((channel, payload))
    )

    notifier.notify(OUTCOME)

    assert len(published) == 1
    channel, payload = published[0]
    assert channel == "judge:results"
    assert json.loads(payload) == {
        "submission_id": RESULT.submission_id,
        "match_id": "00000000-0000-0000-0000-000000000003",
        "round_id": "00000000-0000-0000-0000-000000000004",
        "user_id": "00000000-0000-0000-0000-000000000001",
        "verdict": "AC",
        "passed": 12,
        "total": 12,
        "exec_time_ms": 321,
    }


@pytest.mark.parametrize(
    "row",
    [
        None,
        ROW[:-1],
        (*ROW[:4], "INVALID", *ROW[5:]),
        (*ROW[:5], 13, 12, 321, "completed"),
        (*ROW[:8], "judging"),
    ],
)
def test_missing_or_inconsistent_durable_result_is_not_published(
    row: tuple[object, ...] | None,
) -> None:
    published: list[tuple[str, str]] = []
    notifier = PostgresRedisResultNotifier(
        ScriptedDatabase([row]).connect,
        lambda channel, payload: published.append((channel, payload)),
    )

    with pytest.raises(ResultNotificationError):
        notifier.notify(OUTCOME)

    assert published == []


def test_database_and_redis_errors_are_sanitized() -> None:
    database = ScriptedDatabase([], error=RuntimeError("postgres://secret@db"))
    notifier = PostgresRedisResultNotifier(database.connect, lambda channel, payload: None)

    with pytest.raises(ResultNotificationError) as captured:
        notifier.notify(OUTCOME)

    assert "secret" not in str(captured.value)

    notifier = PostgresRedisResultNotifier(
        ScriptedDatabase([ROW]).connect,
        lambda channel, payload: (_ for _ in ()).throw(RuntimeError("redis://secret@cache")),
    )
    with pytest.raises(ResultNotificationError) as captured:
        notifier.notify(OUTCOME)
    assert "secret" not in str(captured.value)
