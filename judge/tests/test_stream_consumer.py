"""Pruebas de transporte y confirmación segura por lote."""

from dataclasses import dataclass, field
from typing import Any

import pytest

from judge.stream_consumer import (
    ConsumerBatchStats,
    RedisPyStreamTransport,
    StreamConsumer,
    StreamEntry,
    StreamTransportError,
)
from judge.worker import EntryDisposition, EntryOutcome


@dataclass
class FakeTransport:
    entries: list[StreamEntry]
    stale_entries: list[StreamEntry] = field(default_factory=list)
    ack_result: bool = True
    read_error: Exception | None = None
    recovery_error: Exception | None = None
    ack_error: Exception | None = None
    acked_ids: list[str] = field(default_factory=list)

    def claim_stale(self, consumer_name: str, count: int, min_idle_ms: int) -> list[StreamEntry]:
        if self.recovery_error:
            raise self.recovery_error
        return self.stale_entries[:count]

    def read_new(self, consumer_name: str, count: int, block_ms: int) -> list[StreamEntry]:
        if self.read_error:
            raise self.read_error
        return self.entries[:count]

    def ack(self, message_id: str) -> bool:
        self.acked_ids.append(message_id)
        if self.ack_error:
            raise self.ack_error
        return self.ack_result


@dataclass
class FakeCoordinator:
    outcomes: list[EntryOutcome]
    error_at: int | None = None
    calls: int = 0

    def handle(self, message_id: str, fields: Any) -> EntryOutcome:
        index = self.calls
        self.calls += 1
        if self.error_at == index:
            raise RuntimeError("private payload")
        return self.outcomes[index]


def entry(message_id: str) -> StreamEntry:
    return StreamEntry(message_id, {"source_code": "private"})


def test_batch_acks_only_safe_outcomes_and_continues_after_error() -> None:
    transport = FakeTransport([entry("1-0"), entry("2-0"), entry("3-0")])
    coordinator = FakeCoordinator(
        [
            EntryOutcome(EntryDisposition.ACK_RESULT),
            EntryOutcome(EntryDisposition.RETRY),
            EntryOutcome(EntryDisposition.ACK_DUPLICATE),
        ],
        error_at=1,
    )

    stats = StreamConsumer(
        "worker-1", transport, coordinator, count=3, block_ms=10, recovery_idle_ms=10
    ).poll_once()

    assert stats == ConsumerBatchStats(read=3, acknowledged=2, retried=1)
    assert transport.acked_ids == ["1-0", "3-0"]


@pytest.mark.parametrize("raises", [False, True])
def test_ack_failure_is_reported_and_message_is_not_counted_as_acknowledged(
    raises: bool,
) -> None:
    transport = FakeTransport(
        [entry("1-0")],
        ack_result=False,
        ack_error=RuntimeError("redis") if raises else None,
    )
    coordinator = FakeCoordinator([EntryOutcome(EntryDisposition.ACK_RESULT)])

    stats = StreamConsumer("worker-1", transport, coordinator, recovery_idle_ms=10).poll_once()

    assert stats == ConsumerBatchStats(read=1, ack_failures=1)


def test_read_failure_is_sanitized_as_stats() -> None:
    transport = FakeTransport([], read_error=RuntimeError("redis password"))

    stats = StreamConsumer(
        "worker-1", transport, FakeCoordinator([]), recovery_idle_ms=10
    ).poll_once()

    assert stats == ConsumerBatchStats(read_failed=True)


def test_stale_entries_are_prioritized_and_counted_as_recovered() -> None:
    transport = FakeTransport([entry("new-0")], stale_entries=[entry("stale-0")])

    stats = StreamConsumer(
        "worker-2",
        transport,
        FakeCoordinator([EntryOutcome(EntryDisposition.ACK_RESULT)]),
        recovery_idle_ms=10,
    ).poll_once()

    assert stats == ConsumerBatchStats(read=1, recovered=1, acknowledged=1)
    assert transport.acked_ids == ["stale-0"]


def test_recovery_failure_does_not_read_or_ack_new_messages() -> None:
    transport = FakeTransport([entry("new-0")], recovery_error=RuntimeError("redis password"))

    stats = StreamConsumer(
        "worker-2", transport, FakeCoordinator([]), recovery_idle_ms=10
    ).poll_once()

    assert stats == ConsumerBatchStats(recovery_failed=True)
    assert transport.acked_ids == []


@dataclass
class FakeRedis:
    response: object = field(default_factory=list)
    autoclaim_response: object = field(default_factory=lambda: (b"0-0", [], []))
    group_error: Exception | None = None
    ack_value: int = 1
    calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = field(default_factory=list)

    def xgroup_create(self, *args: Any, **kwargs: Any) -> bool:
        self.calls.append(("xgroup_create", args, kwargs))
        if self.group_error:
            raise self.group_error
        return True

    def xreadgroup(self, *args: Any, **kwargs: Any) -> object:
        self.calls.append(("xreadgroup", args, kwargs))
        return self.response

    def xautoclaim(self, *args: Any, **kwargs: Any) -> object:
        self.calls.append(("xautoclaim", args, kwargs))
        return self.autoclaim_response

    def xack(self, *args: Any, **kwargs: Any) -> int:
        self.calls.append(("xack", args, kwargs))
        return self.ack_value


def test_redis_adapter_creates_group_reads_bytes_and_acks() -> None:
    redis = FakeRedis(response=[(b"judge:stream", [(b"1-0", {b"submission_id": b"one"})])])
    transport = RedisPyStreamTransport(redis)

    assert transport.ensure_group()
    entries = transport.read_new("worker-1", 5, 250)
    assert entries == (StreamEntry("1-0", {b"submission_id": b"one"}),)
    assert transport.ack("1-0")
    assert redis.calls == [
        (
            "xgroup_create",
            ("judge:stream", "judges"),
            {"id": "0-0", "mkstream": True},
        ),
        (
            "xreadgroup",
            ("judges", "worker-1", {"judge:stream": ">"}),
            {"count": 5, "block": 250},
        ),
        ("xack", ("judge:stream", "judges", "1-0"), {}),
    ]


def test_existing_group_is_not_an_error_but_other_failures_are_sanitized() -> None:
    existing = RedisPyStreamTransport(FakeRedis(group_error=RuntimeError("BUSYGROUP exists")))
    assert not existing.ensure_group()

    failing = RedisPyStreamTransport(
        FakeRedis(group_error=RuntimeError("redis://user:password@host"))
    )
    with pytest.raises(StreamTransportError) as captured:
        failing.ensure_group()
    assert "password" not in str(captured.value)


def test_redis_adapter_recovers_stale_entries_with_xautoclaim() -> None:
    redis = FakeRedis(autoclaim_response=(b"0-0", [(b"1-0", {b"submission_id": b"one"})], []))
    transport = RedisPyStreamTransport(redis)

    entries = transport.claim_stale("worker-2", 5, 120_000)

    assert entries == (StreamEntry("1-0", {b"submission_id": b"one"}),)
    assert redis.calls == [
        (
            "xautoclaim",
            ("judge:stream", "judges", "worker-2", 120_000, "0-0"),
            {"count": 5},
        )
    ]


@pytest.mark.parametrize(
    "response",
    [
        "invalid",
        [(b"other", [])],
        [(b"judge:stream", [(b"1-0", "not-fields")])],
        [(b"judge:stream", [(b"\xff", {})])],
    ],
)
def test_invalid_redis_responses_are_rejected_without_payload(response: object) -> None:
    transport = RedisPyStreamTransport(FakeRedis(response=response))

    with pytest.raises(StreamTransportError):
        transport.read_new("worker-1", 1, 10)


@pytest.mark.parametrize(
    "response",
    ["invalid", (b"0-0", "not-entries"), (b"0-0", [(b"1-0", "not-fields")])],
)
def test_invalid_autoclaim_responses_are_rejected(response: object) -> None:
    transport = RedisPyStreamTransport(FakeRedis(autoclaim_response=response))

    with pytest.raises(StreamTransportError):
        transport.claim_stale("worker-2", 1, 10)
