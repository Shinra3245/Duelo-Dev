"""El backend Docker se prueba con invocador falso; el runtime real ocurre en la VM."""

from dataclasses import dataclass, field
from io import BytesIO
import os
from pathlib import Path
import tarfile

import pytest

from judge.compiler import CompilationObservation, CompilationRequest, compilation_request
from judge.docker_compiler import (
    MAX_ARTIFACT_BYTES,
    DockerCompilationBackend,
    _artifact_archive,
    artifact_commit_argv,
    artifact_copy_to_running_session_argv,
    artifact_copy_argv,
    artifact_staging_create_argv,
    artifact_staging_start_argv,
    compile_container_argv,
)
from judge.limits import Language
from judge.runtime import RuntimeObservation
from judge.sandbox import RUNNER_GID, RUNNER_UID


DIGEST_A = "a" * 64
DIGEST_B = "b" * 64
DIGEST_C = "c" * 64
BASE_IMAGES: dict[Language, str] = {
    "python": f"python@sha256:{DIGEST_A}",
    "cpp": f"gcc@sha256:{DIGEST_B}",
    "java": f"eclipse-temurin@sha256:{DIGEST_C}",
}
ARTIFACT_ID = "sha256:" + "d" * 64
CONTAINER_ID = "e" * 64


@dataclass
class FakeInvoker:
    observations: list[RuntimeObservation]
    calls: list[tuple[tuple[str, ...], bytes, int]] = field(default_factory=list)

    def invoke(self, argv: tuple[str, ...], stdin: bytes, timeout_ms: int) -> RuntimeObservation:
        self.calls.append((argv, stdin, timeout_ms))
        return self.observations.pop(0)


def observation(
    stdout: bytes = b"", exit_code: int = 0, *, system_error: bool = False
) -> RuntimeObservation:
    return RuntimeObservation(stdout, b"", exit_code, 10, system_error=system_error)


def test_cpp_compiles_then_commits_read_only_artifact_without_running_source() -> None:
    invoker = FakeInvoker(
        [
            observation(),
            observation((CONTAINER_ID + "\n").encode()),
            observation(),
            observation((ARTIFACT_ID + "\n").encode()),
            observation(),
        ]
    )
    backend = DockerCompilationBackend(invoker, BASE_IMAGES, resource_owner="worker-1")
    request = compilation_request("cpp", "int main(){return 0;}")

    result = backend.prepare(request)

    assert result == CompilationObservation(ARTIFACT_ID)
    assert len(invoker.calls) == 5
    compile_argv, compile_stdin, _ = invoker.calls[0]
    assert compile_argv[:2] == ("docker", "run")
    assert "--network" in compile_argv and "none" in compile_argv
    assert "--read-only" in compile_argv
    assert "--cap-drop" in compile_argv and "ALL" in compile_argv
    assert "--mount" in compile_argv
    assert request.source.decode() not in compile_argv
    assert compile_stdin == b""

    create_argv = invoker.calls[1][0]
    assert create_argv[:2] == ("docker", "create")
    assert BASE_IMAGES["cpp"] in create_argv
    assert "duelodev.judge.worker=worker-1" in create_argv
    assert invoker.calls[2][0] == artifact_copy_argv(CONTAINER_ID)
    with tarfile.open(fileobj=BytesIO(invoker.calls[2][1])) as archive:
        entries = {entry.name: entry for entry in archive.getmembers()}
        assert entries["app/main.cpp"].mode == 0o444
        assert (entries["app/main.cpp"].uid, entries["app/main.cpp"].gid) == (
            RUNNER_UID,
            RUNNER_GID,
        )
        source = archive.extractfile("app/main.cpp")
        assert source is not None and source.read() == request.source
        assert entries["out"].mode == 0o555
    commit_argv = invoker.calls[3][0]
    assert commit_argv[:2] == ("docker", "commit")
    assert CONTAINER_ID in commit_argv
    assert "LABEL duelodev.judge.worker=worker-1" in commit_argv
    assert request.source.decode() not in commit_argv
    assert invoker.calls[4][0] == ("docker", "rm", "--force", CONTAINER_ID)


def test_python_packs_without_compilation_and_cpp_output_is_executable(tmp_path: Path) -> None:
    invoker = FakeInvoker(
        [
            observation((CONTAINER_ID + "\n").encode()),
            observation(),
            observation(),
        ]
    )

    result = DockerCompilationBackend(invoker, BASE_IMAGES).prepare(
        compilation_request("python", "print('ok')")
    )

    assert result.artifact_reference == f"container:{CONTAINER_ID}"
    assert len(invoker.calls) == 3
    assert invoker.calls[0][0][:2] == ("docker", "create")
    assert invoker.calls[1][0] == artifact_staging_start_argv(CONTAINER_ID)
    with tarfile.open(fileobj=BytesIO(invoker.calls[2][1])) as archive:
        source = archive.getmember("app/main.py")
        assert source.mode == 0o444
        source_file = archive.extractfile(source)
        assert source_file is not None and source_file.read() == b"print('ok')"
    assert invoker.calls[2][0] == artifact_copy_to_running_session_argv(CONTAINER_ID)

    app = tmp_path / "app"
    out = tmp_path / "out"
    app.mkdir()
    out.mkdir()
    (app / "main.cpp").write_text("int main() {}", encoding="utf-8")
    (out / "main").write_bytes(b"trusted compiler output")
    with tarfile.open(fileobj=BytesIO(_artifact_archive(app, out, "main"))) as archive:
        executable = archive.getmember("out/main")
        assert executable.mode == 0o555
        executable_file = archive.extractfile(executable)
        assert executable_file is not None and executable_file.read() == b"trusted compiler output"


def test_staging_archive_rejects_symlinks_hardlinks_and_oversized_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = tmp_path / "app"
    out = tmp_path / "out"
    app.mkdir()
    out.mkdir()
    source = app / "main.py"
    source.write_text("print(1)", encoding="utf-8")
    hardlink = out / "hardlink"
    os.link(source, hardlink)
    with pytest.raises(ValueError, match="no regular"):
        _artifact_archive(app, out)
    hardlink.unlink()
    (out / "escape").symlink_to("/etc/passwd")
    with pytest.raises(ValueError, match="no regular"):
        _artifact_archive(app, out)

    (out / "escape").unlink()
    (out / "large").write_bytes(b"x" * 8)
    monkeypatch.setattr("judge.docker_compiler.MAX_ARTIFACT_BYTES", 4)
    with pytest.raises(ValueError, match="límite"):
        _artifact_archive(app, out)
    assert MAX_ARTIFACT_BYTES > 4


def test_compile_failure_does_not_create_staging_container() -> None:
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
def test_docker_compile_failures_are_system_errors(exit_code: int) -> None:
    invoker = FakeInvoker([observation(exit_code=exit_code)])

    result = DockerCompilationBackend(invoker, BASE_IMAGES).prepare(
        compilation_request("java", "class Main {}")
    )

    assert result.system_error


def test_failed_staging_create_is_cleaned_by_its_unique_label() -> None:
    invoker = FakeInvoker([observation(exit_code=125), observation()])

    result = DockerCompilationBackend(invoker, BASE_IMAGES).prepare(
        compilation_request("python", "print('ok')")
    )

    assert result.system_error
    assert invoker.calls[1][0][:5] == (
        "docker",
        "ps",
        "--all",
        "--quiet",
        "--filter",
    )
    assert len(invoker.calls) == 2


def test_copy_failure_removes_staging_container_and_artifact_tag() -> None:
    invoker = FakeInvoker(
        [
            observation((CONTAINER_ID + "\n").encode()),
            observation(),
            observation(exit_code=1),
            observation(),
        ]
    )

    result = DockerCompilationBackend(invoker, BASE_IMAGES).prepare(
        compilation_request("python", "print('ok')")
    )

    assert result.system_error
    assert invoker.calls[3][0] == ("docker", "rm", "--force", CONTAINER_ID)


def test_commit_failure_cleans_container_and_tag() -> None:
    invoker = FakeInvoker(
        [
            observation(),
            observation((CONTAINER_ID + "\n").encode()),
            observation(),
            observation(exit_code=1),
            observation(),
            observation(),
        ]
    )

    result = DockerCompilationBackend(invoker, BASE_IMAGES).prepare(
        compilation_request("cpp", "int main(){}")
    )

    assert result.system_error
    assert invoker.calls[4][0] == ("docker", "rm", "--force", CONTAINER_ID)
    assert invoker.calls[5][0][:4] == ("docker", "image", "rm", "--force")


def test_direct_container_cleanup_is_idempotent_after_session_close() -> None:
    invoker = FakeInvoker([observation(exit_code=1), observation()])
    backend = DockerCompilationBackend(invoker, BASE_IMAGES)

    assert backend.cleanup(f"container:{CONTAINER_ID}")
    assert invoker.calls[0][0] == ("docker", "rm", "--force", CONTAINER_ID)
    assert invoker.calls[1][0][-1] == f"id={CONTAINER_ID}"


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


def test_command_builders_reject_untrusted_identifiers_and_keep_fixed_inputs() -> None:
    request = compilation_request("cpp", "int main(){}")
    app = Path("/tmp/app")
    out = Path("/tmp/out")
    compile_argv = compile_container_argv(request, BASE_IMAGES["cpp"], app, out)

    assert compile_argv[-len(request.compile_argv or ()) :] == request.compile_argv
    assert "--network" in compile_argv and "none" in compile_argv
    assert artifact_staging_create_argv(BASE_IMAGES["cpp"], "a" * 32)[-1] == BASE_IMAGES["cpp"]
    direct_argv = artifact_staging_create_argv(BASE_IMAGES["python"], "a" * 32, direct_session=True)
    assert "--read-only" in direct_argv
    assert "--network" in direct_argv and "none" in direct_argv
    assert artifact_staging_start_argv(CONTAINER_ID) == ("docker", "start", CONTAINER_ID)
    assert artifact_copy_to_running_session_argv(CONTAINER_ID)[:2] == ("docker", "exec")
    assert artifact_copy_argv(CONTAINER_ID) == (
        "docker",
        "cp",
        "--archive",
        "-",
        f"{CONTAINER_ID}:/",
    )
    with pytest.raises(ValueError, match="token"):
        artifact_staging_create_argv(BASE_IMAGES["cpp"], "invalid")
    with pytest.raises(ValueError, match="identificador"):
        artifact_copy_argv("latest")
    with pytest.raises(ValueError, match="digest"):
        compile_container_argv(request, "gcc@sha256:" + DIGEST_A + "\nRUN id", app, out)
    with pytest.raises(ValueError, match="etiqueta"):
        artifact_commit_argv(CONTAINER_ID, "latest")


def test_source_name_cannot_escape_the_private_context() -> None:
    with pytest.raises(ValueError, match="fuente"):
        CompilationRequest(
            language="python",
            source_name="../main.py",
            source=b"print('ok')",
            run_argv=("python3", "/app/main.py"),
        )
