"""Limpieza por propietario y exclusión de instancias del worker."""

from pathlib import Path
import subprocess

import pytest

from judge.resources import (
    WorkerInstanceLock,
    WorkerResourceError,
    cleanup_worker_resources,
)


def test_instance_lock_rejects_duplicate_and_can_be_reacquired(tmp_path: Path) -> None:
    first = WorkerInstanceLock(tmp_path, "worker-1")
    second = WorkerInstanceLock(tmp_path, "worker-1")
    first.acquire()
    try:
        with pytest.raises(WorkerResourceError, match="instancia activa"):
            second.acquire()
    finally:
        first.release()

    second.acquire()
    second.release()


def test_instance_lock_rejects_symlink_runtime_directory(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    linked = tmp_path / "linked"
    linked.symlink_to(target, target_is_directory=True)

    with pytest.raises(WorkerResourceError, match="seguro"):
        WorkerInstanceLock(linked, "worker-1")


def test_instance_lock_rejects_runtime_directory_visible_to_other_users(tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir(mode=0o755)

    with pytest.raises(WorkerResourceError, match="seguro"):
        WorkerInstanceLock(runtime_dir, "worker-1")


def test_cleanup_removes_only_resources_labeled_for_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    listings = iter(["a" * 64 + "\n", "sha256:" + "b" * 64 + "\n"])
    listed: list[tuple[str, ...]] = []
    removed: list[tuple[str, ...]] = []

    def check_output(argv: tuple[str, ...], **kwargs: object) -> str:
        listed.append(argv)
        return next(listings)

    def run(argv: tuple[str, ...], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        removed.append(argv)
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr(subprocess, "check_output", check_output)
    monkeypatch.setattr(subprocess, "run", run)

    cleanup_worker_resources("worker-1")

    assert all("label=duelodev.judge.worker=worker-1" in argv for argv in listed)
    assert removed == [
        ("docker", "rm", "--force", "a" * 64),
        ("docker", "image", "rm", "--force", "sha256:" + "b" * 64),
    ]


def test_cleanup_fails_closed_on_unexpected_identifier(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(subprocess, "check_output", lambda *args, **kwargs: "not-an-id\n")

    with pytest.raises(WorkerResourceError, match="identificadores"):
        cleanup_worker_resources("worker-1")


@pytest.mark.parametrize("worker_id", ["", "../worker", "worker value", "x" * 129])
def test_owner_identifier_is_strict(worker_id: str, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="formato"):
        WorkerInstanceLock(tmp_path, worker_id)
