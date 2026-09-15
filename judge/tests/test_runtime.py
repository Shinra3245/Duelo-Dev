"""El adaptador se prueba sin Docker; el invoker real se valida solo en la VM."""

from dataclasses import dataclass

import pytest

from judge.limits import WALL_CLOCK_MARGIN
from judge.runtime import DockerCaseRunner, RuntimeObservation, docker_run_argv
from judge.sandbox import SandboxSpec
from judge.supervisor import CompiledArtifact


def spec() -> SandboxSpec:
    return SandboxSpec("runner@sha256:abc", ("/app/run", "--safe"), 2000)


def test_docker_argv_has_no_shell_network_or_host_mounts() -> None:
    argv = docker_run_argv(spec())
    assert argv[:7] == ("docker", "run", "--rm", "--interactive", "--pull", "never", "--network")
    assert "none" in argv
    assert "--read-only" in argv
    assert "--volume" not in argv and "-v" not in argv and "--mount" not in argv
    assert "--privileged" not in argv
    assert argv[-3:] == ("runner@sha256:abc", "/app/run", "--safe")


@dataclass
class FakeInvoker:
    argv: tuple[str, ...] | None = None
    stdin: bytes | None = None
    timeout_ms: int | None = None

    def invoke(self, argv: tuple[str, ...], stdin: bytes, timeout_ms: int) -> RuntimeObservation:
        self.argv, self.stdin, self.timeout_ms = argv, stdin, timeout_ms
        return RuntimeObservation(b"output", b"", 0, 17)


def test_runner_forwards_only_stdin_and_maps_observation() -> None:
    invoker = FakeInvoker()
    result = DockerCaseRunner(invoker).run_case(
        CompiledArtifact("runner@sha256:abc"), spec(), b"private-input", 3
    )
    assert invoker.stdin == b"private-input"
    assert invoker.timeout_ms == int(2000 * WALL_CLOCK_MARGIN)
    assert result.ordinal == 3
    assert result.stdout == b"output"
    assert result.time_ms == 17


def test_artifact_cannot_select_another_image() -> None:
    with pytest.raises(ValueError, match="coincidir"):
        DockerCaseRunner(FakeInvoker()).run_case(CompiledArtifact("other@sha256:x"), spec(), b"", 1)
