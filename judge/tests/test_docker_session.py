"""Pruebas del backend persistente con un invocador Docker falso."""

from dataclasses import dataclass, field

import pytest

from judge.docker_session import DockerSessionBackend, session_create_argv
from judge.runtime import RuntimeObservation
from judge.sandbox import SandboxSpec


CONTAINER_ID = "a" * 64
TOKEN = "b" * 32


def observation(stdout: bytes = b"", exit_code: int = 0, **changes: bool) -> RuntimeObservation:
    return RuntimeObservation(stdout, b"", exit_code, 5, **changes)


@dataclass
class FakeInvoker:
    observations: list[RuntimeObservation]
    calls: list[tuple[tuple[str, ...], bytes, int]] = field(default_factory=list)

    def invoke(self, argv: tuple[str, ...], stdin: bytes, timeout_ms: int) -> RuntimeObservation:
        self.calls.append((argv, stdin, timeout_ms))
        return self.observations.pop(0)


def spec() -> SandboxSpec:
    return SandboxSpec("sha256:" + "c" * 64, ("python3", "/app/main.py"), 1000)


def started_backend(*later: RuntimeObservation) -> tuple[DockerSessionBackend, FakeInvoker]:
    invoker = FakeInvoker(
        [
            observation((CONTAINER_ID + "\n").encode()),
            observation(),
            *later,
        ]
    )
    backend = DockerSessionBackend(invoker, lambda: TOKEN)
    assert backend.start(spec()) == CONTAINER_ID
    return backend, invoker


def test_create_argv_has_no_network_mount_or_player_command() -> None:
    argv = session_create_argv(spec(), TOKEN)

    assert argv[:2] == ("docker", "create")
    assert "--init" in argv and "--read-only" in argv
    assert "--network" in argv and "none" in argv
    assert "--volume" not in argv and "--mount" not in argv
    assert ("--user", "0:0") == argv[argv.index("--user") : argv.index("--user") + 2]
    assert "KILL" in argv and "DAC_OVERRIDE" in argv and "FOWNER" in argv
    assert spec().command[0] not in argv


def test_session_is_labeled_with_worker_owner() -> None:
    argv = session_create_argv(spec(), TOKEN, "worker-1")

    assert "duelodev.judge.session=" + TOKEN in argv
    assert "duelodev.judge.worker=worker-1" in argv


def test_execute_uses_unprivileged_uid_and_forwards_only_stdin() -> None:
    backend, invoker = started_backend(observation(b"answer\n"))

    result = backend.execute(CONTAINER_ID, spec().command, b"private-input", 1500)

    assert result.stdout == b"answer\n"
    execution = invoker.calls[-1]
    assert execution[0][:6] == (
        "docker",
        "exec",
        "--interactive",
        "--user",
        "65532:65532",
        CONTAINER_ID,
    )
    assert execution[1] == b"private-input"
    assert execution[2] == 1500


def test_execute_and_reset_proves_clean_exit_without_root_reset() -> None:
    backend, invoker = started_backend(observation(b"answer\n", 255))

    result, clean = backend.execute_and_reset(CONTAINER_ID, spec().command, b"private-input", 1500)

    assert clean
    assert result.stdout == b"answer\n"
    assert result.exit_code == 0
    assert len(invoker.calls) == 3
    argv, stdin, timeout_ms = invoker.calls[-1]
    assert argv[:6] == (
        "docker",
        "exec",
        "--interactive",
        "--user",
        "65532:65532",
        CONTAINER_ID,
    )
    assert argv[6:8] == ("/bin/sh", "-c")
    assert '"$@"' in argv[8]
    assert "<&3 3<&-" in argv[8]
    assert argv[9:12] == ("duelodev-session", *spec().command)
    assert stdin == b"private-input"
    assert timeout_ms == 1500


def test_execute_and_reset_maps_nonzero_exit_without_confusing_cleanup() -> None:
    backend, _ = started_backend(observation(b"diagnostic", 254))

    result, clean = backend.execute_and_reset(CONTAINER_ID, spec().command, b"", 1500)

    assert clean
    assert result.exit_code == 1
    assert result.stdout == b"diagnostic"


def test_execute_and_reset_attributes_clean_oom_exit() -> None:
    backend, _ = started_backend(observation(exit_code=253), observation(b"1\n"))

    result, clean = backend.execute_and_reset(CONTAINER_ID, spec().command, b"", 1500)

    assert clean
    assert result.exit_code == 137
    assert result.oom_killed


def test_execute_and_reset_preserves_oom_when_root_fallback_is_needed() -> None:
    backend, _ = started_backend(
        observation(exit_code=250), observation(b"1\n"), observation(b"clean 1\n")
    )

    result, clean = backend.execute_and_reset(CONTAINER_ID, spec().command, b"", 1500)

    assert clean
    assert result.exit_code == 137
    assert result.oom_killed


def test_execute_and_reset_falls_back_to_root_for_unproven_cleanup() -> None:
    backend, invoker = started_backend(observation(b"partial", 143), observation(b"clean 0\n"))

    result, clean = backend.execute_and_reset(CONTAINER_ID, spec().command, b"", 1500)

    assert clean
    assert result.exit_code == 143
    assert invoker.calls[-1][0][:6] == (
        "docker",
        "exec",
        "--user",
        "0:0",
        CONTAINER_ID,
        "/bin/sh",
    )


def test_execute_and_reset_preserves_success_after_root_fallback() -> None:
    backend, _ = started_backend(observation(exit_code=252), observation(b"clean 0\n"))

    result, clean = backend.execute_and_reset(CONTAINER_ID, spec().command, b"", 1500)

    assert clean
    assert result.exit_code == 0


def test_execute_and_reset_preserves_nonzero_after_root_fallback() -> None:
    backend, _ = started_backend(observation(exit_code=251), observation(b"clean 0\n"))

    result, clean = backend.execute_and_reset(CONTAINER_ID, spec().command, b"", 1500)

    assert clean
    assert result.exit_code == 1


def test_execute_and_reset_tracks_oom_when_root_fallback_is_needed() -> None:
    backend, _ = started_backend(
        observation(exit_code=250), observation(b"1\n"), observation(b"clean 1\n")
    )

    result, clean = backend.execute_and_reset(CONTAINER_ID, spec().command, b"", 1500)

    assert clean
    assert result.exit_code == 137
    assert result.oom_killed


def test_oom_is_attributed_from_cgroup_counter() -> None:
    backend, _ = started_backend(observation(exit_code=137), observation(b"1\n"))

    result = backend.execute(CONTAINER_ID, spec().command, b"", 1500)

    assert result.oom_killed


def test_exit_137_without_cgroup_increment_is_not_mle() -> None:
    backend, _ = started_backend(observation(exit_code=137), observation(b"0\n"))

    result = backend.execute(CONTAINER_ID, spec().command, b"", 1500)

    assert not result.oom_killed


def test_exit_137_with_unreadable_counter_becomes_system_error() -> None:
    backend, _ = started_backend(observation(exit_code=137), observation(b"unavailable", 1))

    result = backend.execute(CONTAINER_ID, spec().command, b"", 1500)

    assert result.system_error
    assert not result.oom_killed


def test_reset_runs_fixed_root_controller_and_requires_exact_proof() -> None:
    backend, invoker = started_backend(observation(b"clean 0\n"))

    assert backend.reset(CONTAINER_ID)
    argv = invoker.calls[-1][0]
    assert argv[:6] == ("docker", "exec", "--user", "0:0", CONTAINER_ID, "/bin/sh")
    assert "65532" in argv[-1]


def test_reset_requires_cleanup_and_a_valid_oom_counter() -> None:
    backend, _ = started_backend(observation(b"clean\n"))

    assert not backend.reset(CONTAINER_ID)


def test_start_uses_new_cgroups_zero_oom_baseline_without_extra_exec() -> None:
    invoker = FakeInvoker([observation((CONTAINER_ID + "\n").encode()), observation()])
    backend = DockerSessionBackend(invoker, lambda: TOKEN)

    assert backend.start(spec()) == CONTAINER_ID
    assert len(invoker.calls) == 2
    assert all(call[0][:2] != ("docker", "exec") for call in invoker.calls)


def test_close_falls_back_to_label_and_forgets_only_after_removal() -> None:
    backend, invoker = started_backend(
        observation(exit_code=1), observation((CONTAINER_ID + "\n").encode()), observation()
    )

    assert backend.close(CONTAINER_ID)
    assert invoker.calls[-2][0][-1] == f"label=duelodev.judge.session={TOKEN}"
    with pytest.raises(ValueError, match="pertenece"):
        backend.close(CONTAINER_ID)


def test_invalid_create_result_triggers_label_cleanup() -> None:
    invoker = FakeInvoker([observation(b"invalid\n"), observation()])
    backend = DockerSessionBackend(invoker, lambda: TOKEN)

    with pytest.raises(RuntimeError, match="crear"):
        backend.start(spec())
    assert invoker.calls[-1][0][-1] == f"label=duelodev.judge.session={TOKEN}"
