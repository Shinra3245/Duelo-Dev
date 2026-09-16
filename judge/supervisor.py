"""Supervisor confiable: coordina casos sin entregar expected al runner.

El runner recibirá exclusivamente el artefacto ya compilado, la especificación
del sandbox y el stdin del caso actual. La comparación permanece fuera del
contenedor de código enviado.
"""

from dataclasses import dataclass, field
from typing import Protocol, Sequence

from judge.evaluation import CaseExecution, SubmissionResult, evaluate_case, summarize
from judge.sandbox import SandboxSpec


@dataclass(frozen=True)
class CompiledArtifact:
    """Referencia opaca generada por la fase de compilación confiable."""

    reference: str

    def __post_init__(self) -> None:
        if not self.reference:
            raise ValueError("La referencia del artefacto es obligatoria")


@dataclass(frozen=True)
class JudgeCase:
    """Material privado del supervisor; no se incluye en repr ni en resultados."""

    ordinal: int
    stdin: bytes = field(repr=False)
    expected: bytes = field(repr=False)

    def __post_init__(self) -> None:
        if type(self.ordinal) is not int or self.ordinal < 1:
            raise ValueError("ordinal debe comenzar en uno")
        if not isinstance(self.stdin, bytes) or not isinstance(self.expected, bytes):
            raise ValueError("stdin y expected deben ser bytes")


@dataclass(frozen=True)
class CaseInput:
    """Entrada mínima que puede cruzar la frontera hacia el runtime."""

    ordinal: int
    stdin: bytes = field(repr=False)

    def __post_init__(self) -> None:
        if type(self.ordinal) is not int or self.ordinal < 1:
            raise ValueError("ordinal debe comenzar en uno")
        if not isinstance(self.stdin, bytes):
            raise ValueError("stdin debe ser bytes")


class CaseRunner(Protocol):
    """Adaptador del runtime; no recibe expected ni la lista de casos."""

    def run_case(
        self, artifact: CompiledArtifact, sandbox: SandboxSpec, stdin: bytes, ordinal: int
    ) -> CaseExecution: ...


class SubmissionRunner(Protocol):
    """Runtime de una sesión completa; nunca recibe salidas esperadas."""

    def run_cases(
        self,
        artifact: CompiledArtifact,
        sandbox: SandboxSpec,
        cases: Sequence[CaseInput],
    ) -> Sequence[CaseExecution]: ...


def judge_cases(
    runner: CaseRunner,
    artifact: CompiledArtifact,
    sandbox: SandboxSpec,
    cases: Sequence[JudgeCase],
) -> SubmissionResult:
    """Ejecuta todos los casos y compara cada salida fuera del runner."""
    _validate_cases(cases)

    results = []
    for case in cases:
        execution = runner.run_case(artifact, sandbox, case.stdin, case.ordinal)
        if execution.ordinal != case.ordinal:
            raise ValueError("El runner devolvió un ordinal distinto")
        results.append(evaluate_case(execution, case.expected))
    return summarize(results, len(cases))


def judge_cases_in_session(
    runner: SubmissionRunner,
    artifact: CompiledArtifact,
    sandbox: SandboxSpec,
    cases: Sequence[JudgeCase],
) -> SubmissionResult:
    """Ejecuta una sesión y conserva expected únicamente en el supervisor."""
    _validate_cases(cases)
    inputs = tuple(CaseInput(case.ordinal, case.stdin) for case in cases)
    executions = tuple(runner.run_cases(artifact, sandbox, inputs))
    if len(executions) != len(cases):
        raise ValueError("El runner devolvió una cantidad distinta de casos")

    results = []
    for case, execution in zip(cases, executions, strict=True):
        if execution.ordinal != case.ordinal:
            raise ValueError("El runner devolvió un ordinal distinto")
        results.append(evaluate_case(execution, case.expected))
    return summarize(results, len(cases))


def _validate_cases(cases: Sequence[JudgeCase]) -> None:
    if not cases:
        raise ValueError("Se requiere al menos un caso")
    if [case.ordinal for case in cases] != list(range(1, len(cases) + 1)):
        raise ValueError("Los casos deben tener ordinales consecutivos y ordenados")
