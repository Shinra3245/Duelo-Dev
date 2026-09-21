"""Contrato puro del sandbox: no inicia Docker ni ejecuta procesos."""

import pytest

from judge.limits import BOX_TMPFS_MB, CPU_LIMIT, MEMORY_LIMIT_MB, PIDS_LIMIT
from judge.sandbox import RUNNER_GID, RUNNER_UID, SandboxSpec


def test_docker_options_are_closed_and_derived_from_limits() -> None:
    spec = SandboxSpec(
        image="registry.example/duelodev-python@sha256:abc",
        command=("python3", "/app/main.py"),
        time_limit_ms=2000,
    )

    assert spec.docker_kwargs() == {
        "image": "registry.example/duelodev-python@sha256:abc",
        "command": ["python3", "/app/main.py"],
        "network_disabled": True,
        "read_only": True,
        "tmpfs": {"/tmp": f"rw,noexec,nosuid,size={BOX_TMPFS_MB}m,mode=1777"},
        "user": f"{RUNNER_UID}:{RUNNER_GID}",
        "cap_drop": ["ALL"],
        "security_opt": ["no-new-privileges"],
        "mem_limit": f"{MEMORY_LIMIT_MB}m",
        "memswap_limit": f"{MEMORY_LIMIT_MB}m",
        "nano_cpus": int(CPU_LIMIT * 1_000_000_000),
        "pids_limit": PIDS_LIMIT,
        "volumes": {},
    }


def test_local_content_digest_is_accepted_but_a_mutable_tag_is_not() -> None:
    SandboxSpec("sha256:" + "a" * 64, ("/app/run",), 1000)
    SandboxSpec("container:" + "b" * 64, ("/app/run",), 1000)
    with pytest.raises(ValueError):
        SandboxSpec("runner:latest", ("/app/run",), 1000)


@pytest.mark.parametrize(
    ("image", "command", "time_limit_ms", "memory_limit_mb", "pids_limit"),
    [
        ("runner:latest", ("run",), 1, MEMORY_LIMIT_MB, PIDS_LIMIT),
        ("runner@sha256:abc", (), 1, MEMORY_LIMIT_MB, PIDS_LIMIT),
        ("runner@sha256:abc", ("",), 1, MEMORY_LIMIT_MB, PIDS_LIMIT),
        ("runner@sha256:abc", ("run",), 0, MEMORY_LIMIT_MB, PIDS_LIMIT),
        ("runner@sha256:abc", ("run",), 1, MEMORY_LIMIT_MB + 1, PIDS_LIMIT),
        ("runner@sha256:abc", ("run",), 1, MEMORY_LIMIT_MB, PIDS_LIMIT + 1),
    ],
)
def test_invalid_sandbox_configuration_is_rejected(
    image: str, command: tuple[str, ...], time_limit_ms: int, memory_limit_mb: int, pids_limit: int
) -> None:
    with pytest.raises(ValueError):
        SandboxSpec(image, command, time_limit_ms, memory_limit_mb, pids_limit)
