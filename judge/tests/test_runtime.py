"""El adaptador se prueba sin Docker; el invoker real se valida solo en la VM."""

from dataclasses import dataclass
from pathlib import Path
import subprocess
import sys

import pytest

from judge.limits import WALL_CLOCK_MARGIN
from judge.runtime import (
    DockerCaseRunner,
    RuntimeObservation,
    SubprocessDockerInvoker,
    docker_run_argv,
)
from judge.sandbox import SandboxSpec
from judge.supervisor import CompiledArtifact


def spec() -> SandboxSpec:
    return SandboxSpec("runner@sha256:abc", ("/app/run", "--safe"), 2000)


def test_docker_argv_has_no_shell_network_or_host_mounts() -> None:
    argv = docker_run_argv(spec())
    assert argv[:6] == ("docker", "run", "--interactive", "--pull", "never", "--network")
    assert "--rm" not in argv
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


def test_subprocess_invoker_forwards_input_without_a_shell() -> None:
    observation = SubprocessDockerInvoker().invoke(
        (sys.executable, "-c", "import sys; print(sys.stdin.buffer.read().decode())"),
        b"input",
        1000,
    )

    assert observation.stdout == b"input\n"
    assert observation.exit_code == 0
    assert not observation.system_error


def test_subprocess_invoker_marks_output_exceeded() -> None:
    observation = SubprocessDockerInvoker(output_limit_bytes=5).invoke(
        (sys.executable, "-c", "import sys; sys.stdout.write('abcdefgh')"), b"", 1000
    )

    assert observation.output_exceeded
    assert observation.stdout == b"abcde"


def test_subprocess_invoker_enforces_wall_timeout() -> None:
    observation = SubprocessDockerInvoker().invoke(
        (sys.executable, "-c", "import time; time.sleep(1)"), b"", 10
    )

    assert observation.timed_out


def test_oom_state_is_read_before_container_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cidfile = tmp_path / "container.cid"
    cidfile.write_text("controlled-container\n", encoding="utf-8")

    def inspect(*args: object, **kwargs: object) -> str:
        assert args[0] == (
            "docker",
            "inspect",
            "--format",
            "{{.State.OOMKilled}}",
            "controlled-container",
        )
        return "true\n"

    monkeypatch.setattr(subprocess, "check_output", inspect)

    assert SubprocessDockerInvoker._container_oom_killed("docker", str(cidfile))
