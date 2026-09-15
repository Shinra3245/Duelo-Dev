"""Contrato inmutable del contenedor que ejecutará un caso del juez.

Este módulo no inicia Docker. El supervisor es el único que podrá convertir esta
especificación en una llamada al daemon rootless de la VM desechable.
"""

from dataclasses import dataclass
import re
from typing import Final

from judge.limits import BOX_TMPFS_MB, CPU_LIMIT, MEMORY_LIMIT_MB, PIDS_LIMIT

RUNNER_UID: Final[int] = 65532
RUNNER_GID: Final[int] = 65532
_LOCAL_DIGEST: Final[re.Pattern[str]] = re.compile(r"^sha256:[0-9a-f]{64}$")


@dataclass(frozen=True)
class SandboxSpec:
    """Opciones seguras por caso, sin montajes ni acceso a red."""

    image: str
    command: tuple[str, ...]
    time_limit_ms: int
    memory_limit_mb: int = MEMORY_LIMIT_MB
    pids_limit: int = PIDS_LIMIT

    def __post_init__(self) -> None:
        if not self.image or (
            "@sha256:" not in self.image and not _LOCAL_DIGEST.fullmatch(self.image)
        ):
            raise ValueError("La imagen del runner debe estar fijada por digest")
        if not self.command or any(not isinstance(part, str) or not part for part in self.command):
            raise ValueError("El comando debe ser una tupla no vacía de argumentos")
        if type(self.time_limit_ms) is not int or self.time_limit_ms <= 0:
            raise ValueError("time_limit_ms debe ser positivo")
        if (
            type(self.memory_limit_mb) is not int
            or not 1 <= self.memory_limit_mb <= MEMORY_LIMIT_MB
        ):
            raise ValueError("El límite de memoria excede el máximo del juez")
        if type(self.pids_limit) is not int or not 1 <= self.pids_limit <= PIDS_LIMIT:
            raise ValueError("El límite de procesos excede el máximo del juez")

    def docker_kwargs(self) -> dict[str, object]:
        """Argumentos para Docker SDK; no admite volúmenes, red ni privilegios."""
        return {
            "image": self.image,
            "command": list(self.command),
            "network_disabled": True,
            "read_only": True,
            "tmpfs": {"/tmp": f"rw,noexec,nosuid,size={BOX_TMPFS_MB}m,mode=1777"},
            "user": f"{RUNNER_UID}:{RUNNER_GID}",
            "cap_drop": ["ALL"],
            "security_opt": ["no-new-privileges"],
            "mem_limit": f"{self.memory_limit_mb}m",
            "memswap_limit": f"{self.memory_limit_mb}m",
            "nano_cpus": int(CPU_LIMIT * 1_000_000_000),
            "pids_limit": self.pids_limit,
            "volumes": {},
        }
