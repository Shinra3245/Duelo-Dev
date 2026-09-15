"""Adaptador de runtime para el daemon Docker rootless del juez.

No usa shell ni recibe respuestas esperadas. La ejecución real se inyecta para
que la construcción de la invocación pueda probarse sin iniciar contenedores.
"""

from dataclasses import dataclass
from math import ceil
from typing import Protocol

from judge.evaluation import CaseExecution
from judge.limits import BOX_TMPFS_MB, CPU_LIMIT, WALL_CLOCK_MARGIN
from judge.sandbox import RUNNER_GID, RUNNER_UID, SandboxSpec
from judge.supervisor import CompiledArtifact


@dataclass(frozen=True)
class RuntimeObservation:
    stdout: bytes
    stderr: bytes
    exit_code: int
    time_ms: int
    timed_out: bool = False
    oom_killed: bool = False
    output_exceeded: bool = False
    system_error: bool = False


class DockerInvoker(Protocol):
    """Implementación concreta que transmite stdin y limita salida fuera del jugador."""

    def invoke(
        self, argv: tuple[str, ...], stdin: bytes, timeout_ms: int
    ) -> RuntimeObservation: ...


def docker_run_argv(spec: SandboxSpec) -> tuple[str, ...]:
    """Construye argv fijo: no hay interpolación de shell, red ni volúmenes."""
    return (
        "docker",
        "run",
        "--rm",
        "--interactive",
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        f"/tmp:rw,noexec,nosuid,size={BOX_TMPFS_MB}m,mode=1777",
        "--user",
        f"{RUNNER_UID}:{RUNNER_GID}",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        f"{spec.memory_limit_mb}m",
        "--memory-swap",
        f"{spec.memory_limit_mb}m",
        "--cpus",
        str(CPU_LIMIT),
        "--pids-limit",
        str(spec.pids_limit),
        spec.image,
        *spec.command,
    )


class DockerCaseRunner:
    """Entrega stdin al runtime y convierte su observación en datos confiables."""

    def __init__(self, invoker: DockerInvoker) -> None:
        self._invoker = invoker

    def run_case(
        self, artifact: CompiledArtifact, sandbox: SandboxSpec, stdin: bytes, ordinal: int
    ) -> CaseExecution:
        if artifact.reference != sandbox.image:
            raise ValueError("El artefacto debe coincidir con la imagen fijada del sandbox")
        observation = self._invoker.invoke(
            docker_run_argv(sandbox), stdin, ceil(sandbox.time_limit_ms * WALL_CLOCK_MARGIN)
        )
        return CaseExecution(
            ordinal=ordinal,
            stdout=observation.stdout,
            stderr=observation.stderr,
            exit_code=observation.exit_code,
            time_ms=observation.time_ms,
            timed_out=observation.timed_out,
            oom_killed=observation.oom_killed,
            output_exceeded=observation.output_exceeded,
            system_error=observation.system_error,
        )
