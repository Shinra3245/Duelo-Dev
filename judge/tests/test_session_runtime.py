"""La coordinación de sesiones se prueba sin iniciar Docker."""

from dataclasses import dataclass, field

import pytest

from judge.runtime import RuntimeObservation
from judge.sandbox import SandboxSpec
from judge.session_runtime import DockerSubmissionRunner
from judge.supervisor import CaseInput, CompiledArtifact


@dataclass
class FakeBackend:
    observations: list[RuntimeObservation]
    reset_results: list[bool] = field(default_factory=list)
    close_results: list[bool] = field(default_factory=list)
    calls: list[tuple[object, ...]] = field(default_factory=list)
    session_number: int = 0

    def start(self, sandbox: SandboxSpec) -> str:
        self.session_number += 1
        session_id = f"session-{self.session_number}"
        self.calls.append(("start", session_id, sandbox.image))
        return session_id

    def execute(
        self,
        session_id: str,
        command: tuple[str, ...],
        stdin: bytes,
        timeout_ms: int,
    ) -> RuntimeObservation:
        self.calls.append(("execute", session_id, command, stdin, timeout_ms))
        return self.observations.pop(0)

    def reset(self, session_id: str) -> bool:
        self.calls.append(("reset", session_id))
        return self.reset_results.pop(0) if self.reset_results else True

    def close(self, session_id: str) -> bool:
        self.calls.append(("close", session_id))
        return self.close_results.pop(0) if self.close_results else True


def spec() -> SandboxSpec:
    return SandboxSpec("sha256:" + "a" * 64, ("python3", "/app/main.py"), 1000)


def test_reuses_a_clean_session_and_closes_it() -> None:
    backend = FakeBackend(
        [RuntimeObservation(b"one", b"", 0, 4), RuntimeObservation(b"two", b"", 0, 5)]
    )

    executions = DockerSubmissionRunner(backend).run_cases(
        CompiledArtifact(spec().image),
        spec(),
        [CaseInput(1, b"input-one"), CaseInput(2, b"input-two")],
    )

    assert [execution.stdout for execution in executions] == [b"one", b"two"]
    assert backend.calls == [
        ("start", "session-1", spec().image),
        ("execute", "session-1", spec().command, b"input-one", 1500),
        ("reset", "session-1"),
        ("execute", "session-1", spec().command, b"input-two", 1500),
        ("close", "session-1"),
    ]


def test_failed_reset_discards_session_before_next_case() -> None:
    backend = FakeBackend(
        [RuntimeObservation(b"one", b"", 0, 4), RuntimeObservation(b"two", b"", 0, 5)],
        reset_results=[False],
    )

    DockerSubmissionRunner(backend).run_cases(
        CompiledArtifact(spec().image),
        spec(),
        [CaseInput(1, b"one"), CaseInput(2, b"two")],
    )

    assert backend.calls[2:5] == [
        ("reset", "session-1"),
        ("close", "session-1"),
        ("start", "session-2", spec().image),
    ]


def test_contaminated_session_must_close_before_progress() -> None:
    backend = FakeBackend(
        [RuntimeObservation(b"one", b"", 0, 4)],
        reset_results=[False],
        close_results=[False],
    )

    with pytest.raises(RuntimeError, match="contaminada"):
        DockerSubmissionRunner(backend).run_cases(
            CompiledArtifact(spec().image),
            spec(),
            [CaseInput(1, b"one"), CaseInput(2, b"two")],
        )
    assert backend.session_number == 1


def test_final_close_failure_invalidates_results() -> None:
    backend = FakeBackend(
        [RuntimeObservation(b"one", b"", 0, 4)],
        close_results=[False],
    )

    with pytest.raises(RuntimeError, match="cerrar"):
        DockerSubmissionRunner(backend).run_cases(
            CompiledArtifact(spec().image), spec(), [CaseInput(1, b"one")]
        )


def test_artifact_and_case_sequence_are_validated_before_start() -> None:
    backend = FakeBackend([])
    runner = DockerSubmissionRunner(backend)

    with pytest.raises(ValueError, match="coincidir"):
        runner.run_cases(CompiledArtifact("sha256:" + "b" * 64), spec(), [CaseInput(1, b"")])
    with pytest.raises(ValueError, match="consecutivas"):
        runner.run_cases(CompiledArtifact(spec().image), spec(), [CaseInput(2, b"")])
    assert backend.calls == []
