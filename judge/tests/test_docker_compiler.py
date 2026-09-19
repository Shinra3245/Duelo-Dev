"""El backend Docker se prueba con invocador falso; la ejecución real ocurre en la VM."""

from dataclasses import dataclass, field
from pathlib import Path

import pytest

from judge.compiler import CompilationObservation, CompilationRequest, compilation_request
from judge.docker_compiler import (
    DockerCompilationBackend,
    artifact_dockerfile,
    compile_container_argv,
    docker_build_argv,
)
from judge.limits import Language
from judge.runtime import RuntimeObservation


DIGEST_A = "a" * 64
DIGEST_B = "b" * 64
DIGEST_C = "c" * 64
BASE_IMAGES: dict[Language, str] = {
    "python": f"python@sha256:{DIGEST_A}",
    "cpp": f"gcc@sha256:{DIGEST_B}",
    "java": f"eclipse-temurin@sha256:{DIGEST_C}",
}
ARTIFACT_ID = "sha256:" + "d" * 64


@dataclass
class FakeInvoker:
    observations: list[RuntimeObservation]
    calls: list[tuple[tuple[str, ...], bytes, int]] = field(default_factory=list)
    dockerfiles: list[str] = field(default_factory=list)

    def invoke(self, argv: tuple[str, ...], stdin: bytes, timeout_ms: int) -> RuntimeObservation:
        self.calls.append((argv, stdin, timeout_ms))
        if argv[:2] == ("docker", "build"):
            self.dockerfiles.append((Path(argv[-1]) / "Dockerfile").read_text())
        return self.observations.pop(0)


def observation(
    stdout: bytes = b"", exit_code: int = 0, *, system_error: bool = False
) -> RuntimeObservation:
    return RuntimeObservation(stdout, b"", exit_code, 10, system_error=system_error)


def test_cpp_compiles_with_limits_then_packages_without_running_source() -> None:
    invoker = FakeInvoker([observation(), observation((ARTIFACT_ID + "\n").encode())])
    backend = DockerCompilationBackend(invoker, BASE_IMAGES)
    request = compilation_request("cpp", "int main(){return 0;}")

    result = backend.prepare(request)

    assert result == CompilationObservation(ARTIFACT_ID)
    assert len(invoker.calls) == 2
    compile_argv = invoker.calls[0][0]
    assert compile_argv[:2] == ("docker", "run")
    assert "--network" in compile_argv and "none" in compile_argv
    assert "--read-only" in compile_argv
    assert "--cap-drop" in compile_argv and "ALL" in compile_argv
    assert "--mount" in compile_argv
    assert request.source.decode() not in compile_argv
    assert invoker.calls[0][1] == b""
    assert "RUN " not in invoker.dockerfiles[0]
    assert BASE_IMAGES["cpp"] in invoker.dockerfiles[0]
    assert request.source.decode() not in invoker.dockerfiles[0]


def test_python_only_packages_source() -> None:
    invoker = FakeInvoker([observation((ARTIFACT_ID + "\n").encode())])

    result = DockerCompilationBackend(invoker, BASE_IMAGES).prepare(
        compilation_request("python", "print('ok')")
    )

    assert result.artifact_reference == ARTIFACT_ID
    assert len(invoker.calls) == 1
    assert invoker.calls[0][0][:2] == ("docker", "build")


def test_artifact_image_is_labeled_with_worker_owner(tmp_path: Path) -> None:
    argv = docker_build_argv(tmp_path, "duelodev-artifact-" + "a" * 32, "worker-1")

    assert "--label" in argv
    assert "duelodev.judge.worker=worker-1" in argv
    assert argv[-1] == str(tmp_path.resolve())


def test_compile_failure_does_not_build_artifact() -> None:
    invoker = FakeInvoker([RuntimeObservation(b"", b"syntax error", 1, 5)])

    result = DockerCompilationBackend(invoker, BASE_IMAGES).prepare(
        compilation_request("cpp", "invalid")
    )

    assert result.artifact_reference is None
    assert result.stderr == b"syntax error"
    assert result.exit_code == 1
    assert not result.system_error
    assert len(invoker.calls) == 1


@pytest.mark.parametrize("exit_code", [125, 126, 127])
def test_docker_run_failures_are_system_errors(exit_code: int) -> None:
    invoker = FakeInvoker([observation(exit_code=exit_code)])

    result = DockerCompilationBackend(invoker, BASE_IMAGES).prepare(
        compilation_request("java", "class Main {}")
    )

    assert result.system_error


def test_packaging_failure_is_system_error_and_cleans_temporary_tag() -> None:
    invoker = FakeInvoker([observation(), observation(exit_code=1), observation()])

    result = DockerCompilationBackend(invoker, BASE_IMAGES).prepare(
        compilation_request("cpp", "int main(){}")
    )

    assert result.system_error
    assert invoker.calls[-1][0][:4] == ("docker", "image", "rm", "--force")


def test_cleanup_only_accepts_local_digest() -> None:
    invoker = FakeInvoker([observation()])
    backend = DockerCompilationBackend(invoker, BASE_IMAGES)

    assert backend.cleanup(ARTIFACT_ID)
    assert invoker.calls[0][0] == ("docker", "image", "rm", "--force", ARTIFACT_ID)
    with pytest.raises(ValueError, match="digest local"):
        backend.cleanup("latest")


def test_base_images_must_be_complete_and_pinned() -> None:
    incomplete: dict[Language, str] = {"python": BASE_IMAGES["python"]}
    with pytest.raises(ValueError, match="Faltan"):
        DockerCompilationBackend(FakeInvoker([]), incomplete)
    unpinned: dict[Language, str] = {**BASE_IMAGES, "python": "python:latest"}
    with pytest.raises(ValueError, match="digest"):
        DockerCompilationBackend(FakeInvoker([]), unpinned)


def test_paths_and_image_reference_cannot_inject_dockerfile_commands(tmp_path: Path) -> None:
    request = compilation_request("cpp", "int main(){}")
    app = tmp_path / "app"
    out = tmp_path / "out"
    app.mkdir()
    out.mkdir()

    argv = compile_container_argv(request, BASE_IMAGES["cpp"], app, out)

    assert argv[-len(request.compile_argv or ()) :] == request.compile_argv
    with pytest.raises(ValueError, match="digest"):
        artifact_dockerfile("gcc@sha256:" + DIGEST_A + "\nRUN id")


def test_source_name_cannot_escape_the_private_context() -> None:
    with pytest.raises(ValueError, match="fuente"):
        CompilationRequest(
            language="python",
            source_name="../main.py",
            source=b"print('ok')",
            run_argv=("python3", "/app/main.py"),
        )
