"""Exclusión de instancia y limpieza selectiva de recursos Docker tras una caída."""

import fcntl
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
from typing import IO


_OWNER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_CONTAINER_ID = re.compile(r"^[0-9a-f]{12,64}$")
_IMAGE_ID = re.compile(r"^(?:sha256:)?[0-9a-f]{12,64}$")


class WorkerResourceError(RuntimeError):
    """Fallo saneado de exclusión o limpieza del worker."""


class WorkerInstanceLock:
    """Impide dos procesos locales con el mismo worker_id."""

    def __init__(self, runtime_dir: Path, worker_id: str) -> None:
        _validate_owner(worker_id)
        try:
            metadata = runtime_dir.lstat()
        except OSError:
            raise WorkerResourceError("El directorio de runtime no está disponible") from None
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or runtime_dir.is_symlink()
            or metadata.st_uid != os.geteuid()
            or metadata.st_mode & 0o077
        ):
            raise WorkerResourceError("El directorio de runtime no es seguro")
        digest = hashlib.sha256(worker_id.encode()).hexdigest()[:24]
        self._path = runtime_dir / f"worker-{digest}.lock"
        self._file: IO[bytes] | None = None

    def acquire(self) -> None:
        if self._file is not None:
            raise WorkerResourceError("El bloqueo ya fue adquirido")
        descriptor: int | None = None
        file: IO[bytes] | None = None
        try:
            descriptor = os.open(
                self._path,
                os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW,
                0o600,
            )
            file = os.fdopen(descriptor, "r+b", buffering=0)
            fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            if file is not None:
                file.close()
            elif descriptor is not None:
                os.close(descriptor)
            raise WorkerResourceError("Ya existe una instancia activa para worker_id") from None
        assert file is not None
        self._file = file

    def release(self) -> None:
        if self._file is None:
            return
        try:
            fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
        finally:
            self._file.close()
            self._file = None

    def __enter__(self) -> "WorkerInstanceLock":
        self.acquire()
        return self

    def __exit__(self, *args: object) -> None:
        self.release()


def cleanup_worker_resources(worker_id: str) -> None:
    """Elimina sólo contenedores e imágenes etiquetados con el propietario indicado."""
    _validate_owner(worker_id)
    label = f"duelodev.judge.worker={worker_id}"
    containers = _listed_ids(
        ("docker", "ps", "--all", "--quiet", "--filter", f"label={label}"),
        _CONTAINER_ID,
    )
    if containers:
        _run(("docker", "rm", "--force", *containers))
    images = _listed_ids(
        ("docker", "image", "ls", "--quiet", "--filter", f"label={label}"),
        _IMAGE_ID,
    )
    if images:
        _run(("docker", "image", "rm", "--force", *images))


def _listed_ids(argv: tuple[str, ...], pattern: re.Pattern[str]) -> tuple[str, ...]:
    try:
        output = subprocess.check_output(argv, text=True, stderr=subprocess.DEVNULL, timeout=15)
    except (OSError, subprocess.SubprocessError):
        raise WorkerResourceError("No se pudieron enumerar recursos Docker") from None
    identifiers = tuple(dict.fromkeys(output.split()))
    if any(not pattern.fullmatch(identifier) for identifier in identifiers):
        raise WorkerResourceError("Docker devolvió identificadores inválidos")
    return identifiers


def _run(argv: tuple[str, ...]) -> None:
    try:
        completed = subprocess.run(
            argv,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        raise WorkerResourceError("No se pudieron retirar recursos Docker") from None
    if completed.returncode != 0:
        raise WorkerResourceError("No se pudieron retirar recursos Docker")


def _validate_owner(worker_id: str) -> None:
    if not isinstance(worker_id, str) or not _OWNER.fullmatch(worker_id):
        raise ValueError("worker_id tiene un formato inválido")
