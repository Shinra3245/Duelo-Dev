"""Ciclo del worker y sondas de arranque sin Docker, Redis ni PostgreSQL reales."""

from dataclasses import dataclass
import subprocess
import threading

import pytest

from judge.app import docker_prerequisites_ok, run_consumer
from judge.stream_consumer import ConsumerBatchStats


@dataclass
class FakeConsumer:
    outcomes: list[ConsumerBatchStats]
    stop_event: threading.Event
    calls: int = 0

    def poll_once(self) -> ConsumerBatchStats:
        result = self.outcomes[self.calls]
        self.calls += 1
        if self.calls == len(self.outcomes):
            self.stop_event.set()
        return result


def test_loop_reports_each_batch_and_stops_cleanly() -> None:
    stop_event = threading.Event()
    outcomes = [ConsumerBatchStats(read=1, acknowledged=1), ConsumerBatchStats(read_failed=True)]
    consumer = FakeConsumer(outcomes, stop_event)
    reports: list[ConsumerBatchStats] = []

    run_consumer(consumer, stop_event, reports.append, failure_backoff_s=0)

    assert reports == outcomes
    assert consumer.calls == 2


def test_loop_does_not_poll_when_stop_was_already_requested() -> None:
    stop_event = threading.Event()
    stop_event.set()
    consumer = FakeConsumer([], stop_event)

    run_consumer(consumer, stop_event, lambda stats: None)

    assert consumer.calls == 0


def test_rootless_preflight_accepts_only_complete_docker_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def completed(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            "docker",
            0,
            '{"security_options":["name=rootless","name=seccomp"],'
            '"cgroup_version":"2","cgroup_driver":"systemd"}',
        )

    monkeypatch.setattr(subprocess, "run", completed)
    assert docker_prerequisites_ok()


def test_rootless_preflight_hides_command_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        raise subprocess.CalledProcessError(1, "docker", stderr="PRIVATE")

    monkeypatch.setattr(subprocess, "run", fail)
    assert not docker_prerequisites_ok()
