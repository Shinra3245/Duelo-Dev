"""Configuración cerrada del proceso worker a partir del entorno."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
import re
from urllib.parse import urlsplit

from judge.limits import Language


_PINNED_IMAGE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[0-9a-f]{64}$")
_WORKER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


@dataclass(frozen=True)
class WorkerSettings:
    database_url: str = field(repr=False)
    redis_url: str = field(repr=False)
    cases_root: Path
    runtime_dir: Path
    worker_id: str
    lease_duration_ms: int
    recovery_idle_ms: int
    python_image: str
    cpp_image: str
    java_image: str
    batch_size: int = 1
    block_ms: int = 1000

    def __post_init__(self) -> None:
        _validate_url(self.database_url, {"postgres", "postgresql"}, "DATABASE_URL")
        _validate_url(self.redis_url, {"redis", "rediss"}, "REDIS_URL")
        if not isinstance(self.cases_root, Path) or not isinstance(self.runtime_dir, Path):
            raise ValueError("Las raíces del worker deben ser rutas")
        if not _WORKER_ID.fullmatch(self.worker_id):
            raise ValueError("JUDGE_WORKER_ID tiene un formato inválido")
        for name, value in (
            ("JUDGE_LEASE_MS", self.lease_duration_ms),
            ("JUDGE_RECOVERY_IDLE_MS", self.recovery_idle_ms),
            ("JUDGE_BATCH_SIZE", self.batch_size),
            ("JUDGE_BLOCK_MS", self.block_ms),
        ):
            if type(value) is not int or value < 1:
                raise ValueError(f"{name} debe ser un entero positivo")
        if self.recovery_idle_ms <= self.lease_duration_ms:
            raise ValueError("JUDGE_RECOVERY_IDLE_MS debe superar JUDGE_LEASE_MS")
        if self.batch_size > 16:
            raise ValueError("JUDGE_BATCH_SIZE no puede superar 16")
        for image in (self.python_image, self.cpp_image, self.java_image):
            if not _PINNED_IMAGE.fullmatch(image):
                raise ValueError("Las imágenes del juez deben estar fijadas por digest")

    @classmethod
    def from_environ(cls, environ: Mapping[str, str]) -> "WorkerSettings":
        required = (
            "DATABASE_URL",
            "REDIS_URL",
            "JUDGE_CASES_ROOT",
            "JUDGE_RUNTIME_DIR",
            "JUDGE_WORKER_ID",
            "JUDGE_LEASE_MS",
            "JUDGE_RECOVERY_IDLE_MS",
            "JUDGE_IMAGE_PYTHON",
            "JUDGE_IMAGE_CPP",
            "JUDGE_IMAGE_JAVA",
        )
        missing = [name for name in required if not environ.get(name)]
        if missing:
            raise ValueError(f"Falta configuración obligatoria: {', '.join(missing)}")
        return cls(
            database_url=environ["DATABASE_URL"],
            redis_url=environ["REDIS_URL"],
            cases_root=Path(environ["JUDGE_CASES_ROOT"]),
            runtime_dir=Path(environ["JUDGE_RUNTIME_DIR"]),
            worker_id=environ["JUDGE_WORKER_ID"],
            lease_duration_ms=_positive_int(environ["JUDGE_LEASE_MS"], "JUDGE_LEASE_MS"),
            recovery_idle_ms=_positive_int(
                environ["JUDGE_RECOVERY_IDLE_MS"], "JUDGE_RECOVERY_IDLE_MS"
            ),
            python_image=environ["JUDGE_IMAGE_PYTHON"],
            cpp_image=environ["JUDGE_IMAGE_CPP"],
            java_image=environ["JUDGE_IMAGE_JAVA"],
            batch_size=_positive_int(environ.get("JUDGE_BATCH_SIZE", "1"), "JUDGE_BATCH_SIZE"),
            block_ms=_positive_int(environ.get("JUDGE_BLOCK_MS", "1000"), "JUDGE_BLOCK_MS"),
        )

    @property
    def base_images(self) -> dict[Language, str]:
        return {
            "python": self.python_image,
            "cpp": self.cpp_image,
            "java": self.java_image,
        }


def _validate_url(value: str, schemes: set[str], name: str) -> None:
    if not isinstance(value, str):
        raise ValueError(f"{name} debe ser texto")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ValueError(f"{name} tiene un formato inválido") from None
    if parsed.scheme not in schemes or not parsed.hostname or port is None:
        raise ValueError(f"{name} tiene un formato inválido")


def _positive_int(value: str, name: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} debe ser un entero positivo") from None
    if parsed < 1 or str(parsed) != value:
        raise ValueError(f"{name} debe ser un entero positivo")
    return parsed
