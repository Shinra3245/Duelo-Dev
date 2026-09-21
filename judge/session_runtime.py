"""Ejecución de varios casos dentro de una sesión aislada por envío.

La sesión puede reutilizarse únicamente cuando el backend confirma que eliminó
procesos y archivos del jugador. Las respuestas esperadas nunca cruzan esta
frontera.
"""

from math import ceil
from typing import Protocol, Sequence

from judge.evaluation import CaseExecution
from judge.limits import WALL_CLOCK_MARGIN
from judge.runtime import RuntimeObservation
from judge.sandbox import SandboxSpec
from judge.supervisor import CaseInput, CompiledArtifact


class SessionBackend(Protocol):
    """Operaciones privilegiadas dentro del daemon Docker rootless."""

    def start(self, sandbox: SandboxSpec) -> str: ...

    def execute(
        self,
        session_id: str,
        command: tuple[str, ...],
        stdin: bytes,
        timeout_ms: int,
    ) -> RuntimeObservation: ...

    def execute_and_reset(
        self,
        session_id: str,
        command: tuple[str, ...],
        stdin: bytes,
        timeout_ms: int,
    ) -> tuple[RuntimeObservation, bool]: ...

    def reset(self, session_id: str) -> bool: ...

    def close(self, session_id: str) -> bool: ...


class DockerSubmissionRunner:
    """Reutiliza una sesión sólo después de una limpieza confirmada."""

    def __init__(self, backend: SessionBackend) -> None:
        self._backend = backend

    def run_cases(
        self,
        artifact: CompiledArtifact,
        sandbox: SandboxSpec,
        cases: Sequence[CaseInput],
    ) -> Sequence[CaseExecution]:
        if artifact.reference != sandbox.image:
            raise ValueError("El artefacto debe coincidir con la imagen fijada del sandbox")
        if not cases or [case.ordinal for case in cases] != list(range(1, len(cases) + 1)):
            raise ValueError("Las entradas deben ser consecutivas y estar ordenadas")

        session_id: str | None = None
        completed = False
        executions: list[CaseExecution] = []
        try:
            for index, case in enumerate(cases):
                if session_id is None:
                    session_id = self._backend.start(sandbox)
                    if not session_id:
                        raise RuntimeError("El backend no devolvió una sesión")
                timeout_ms = ceil(sandbox.time_limit_ms * WALL_CLOCK_MARGIN)
                if index < len(cases) - 1:
                    observation, clean = self._backend.execute_and_reset(
                        session_id, sandbox.command, case.stdin, timeout_ms
                    )
                else:
                    observation = self._backend.execute(
                        session_id, sandbox.command, case.stdin, timeout_ms
                    )
                    clean = True
                executions.append(_case_execution(case.ordinal, observation))

                if index < len(cases) - 1 and not clean:
                    closed = self._backend.close(session_id)
                    session_id = None
                    if not closed:
                        raise RuntimeError("No se pudo descartar una sesión contaminada")

            completed = True
        finally:
            if session_id is not None:
                closed = self._backend.close(session_id)
                if completed and not closed:
                    raise RuntimeError("No se pudo cerrar la sesión del envío")
        return executions


def _case_execution(ordinal: int, observation: RuntimeObservation) -> CaseExecution:
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
