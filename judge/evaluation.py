"""Evaluación fuera del sandbox: las salidas del programa nunca son órdenes.

No ejecuta código ni accede a Docker. El futuro supervisor proporciona resultados
por caso; los casos esperados permanecen fuera del alcance del programa enviado.
"""

from dataclasses import dataclass, field

from judge.limits import OUTPUT_LIMIT_BYTES
from judge.verdicts import Verdict


def _nonnegative(value: int, name: str) -> None:
    if type(value) is not int or value < 0:
        raise ValueError(f"{name} debe ser un entero no negativo")


def normalize_output(text: str) -> str:
    """Conserva espacios iniciales/internos y líneas vacías adicionales."""
    lines = text.replace("\r\n", "\n").split("\n")
    if lines[-1] == "":
        lines.pop()
    return "\n".join(line.rstrip(" \t") for line in lines)


@dataclass(frozen=True)
class CaseExecution:
    """Observaciones confiables del supervisor, nunca un JSON del programa."""

    ordinal: int
    stdout: bytes = field(repr=False)
    stderr: bytes = field(default=b"", repr=False)
    exit_code: int = 0
    time_ms: int = 0
    timed_out: bool = False
    oom_killed: bool = False
    output_exceeded: bool = False
    system_error: bool = False

    def __post_init__(self) -> None:
        _nonnegative(self.ordinal, "ordinal")
        if self.ordinal == 0:
            raise ValueError("ordinal empieza en uno")
        _nonnegative(self.time_ms, "time_ms")
        if not isinstance(self.stdout, bytes) or not isinstance(self.stderr, bytes):
            raise ValueError("Las salidas deben ser bytes")


@dataclass(frozen=True)
class CaseResult:
    ordinal: int
    verdict: Verdict
    time_ms: int

    def __post_init__(self) -> None:
        _nonnegative(self.ordinal, "ordinal")
        if self.ordinal == 0:
            raise ValueError("ordinal empieza en uno")
        _nonnegative(self.time_ms, "time_ms")
        if not isinstance(self.verdict, Verdict) or self.verdict == Verdict.CE:
            raise ValueError("Veredicto de caso no válido")


@dataclass(frozen=True)
class SubmissionResult:
    verdict: Verdict
    passed: int
    total: int
    exec_time_ms: int


def evaluate_case(execution: CaseExecution, expected: bytes) -> CaseResult:
    """Clasifica fallos antes de comparar; no devuelve stdin/expected/stdout."""
    try:
        expected_text = expected.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("El caso de referencia no es UTF-8 válido") from None
    if "\x00" in expected_text:
        raise ValueError("El caso de referencia contiene datos binarios")

    if execution.system_error:
        verdict = Verdict.SE
    elif execution.oom_killed:
        verdict = Verdict.MLE
    elif execution.timed_out:
        verdict = Verdict.TLE
    elif execution.output_exceeded or max(len(execution.stdout), len(execution.stderr)) > (
        OUTPUT_LIMIT_BYTES
    ):
        verdict = Verdict.OLE
    elif execution.exit_code != 0:
        verdict = Verdict.RE
    else:
        try:
            actual = execution.stdout.decode("utf-8")
        except UnicodeDecodeError:
            verdict = Verdict.WA
        else:
            verdict = (
                Verdict.AC
                if "\x00" not in actual
                and normalize_output(actual) == normalize_output(expected_text)
                else Verdict.WA
            )
    return CaseResult(execution.ordinal, verdict, execution.time_ms)


def summarize(results: list[CaseResult], total: int) -> SubmissionResult:
    """Exige todos los casos y usa ordinal, no orden de llegada del supervisor."""
    _nonnegative(total, "total")
    if total == 0 or len(results) != total:
        raise ValueError("Se requieren todos los casos de un problema no vacío")
    ordered = sorted(results, key=lambda result: result.ordinal)
    if [result.ordinal for result in ordered] != list(range(1, total + 1)):
        raise ValueError("Los ordinales deben ser únicos y consecutivos")
    # Un fallo del evaluador invalida el juicio completo, aunque antes hubiera WA.
    verdict = (
        Verdict.SE
        if any(result.verdict == Verdict.SE for result in ordered)
        else next((r.verdict for r in ordered if r.verdict != Verdict.AC), Verdict.AC)
    )
    return SubmissionResult(
        verdict=verdict,
        passed=sum(result.verdict == Verdict.AC for result in ordered),
        total=total,
        exec_time_ms=sum(result.time_ms for result in ordered),
    )


def compilation_error(total: int) -> SubmissionResult:
    """CE es la única salida normal que no requiere ejecutar los casos."""
    _nonnegative(total, "total")
    if total == 0:
        raise ValueError("El problema debe tener casos")
    return SubmissionResult(Verdict.CE, 0, total, 0)
