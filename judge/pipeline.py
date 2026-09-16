"""Pipeline confiable de un trabajo del juez, independiente de Redis y PostgreSQL."""

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from judge.compiler import MAX_COMPILE_OUTPUT_BYTES, CompilationBackend, prepare_submission
from judge.evaluation import SubmissionResult, compilation_error
from judge.limits import LANGUAGES, MEMORY_LIMIT_MB, SOURCE_CODE_MAX_BYTES, Language
from judge.sandbox import SandboxSpec
from judge.supervisor import CaseRunner, JudgeCase, judge_cases
from judge.verdicts import Verdict


JUDGE_STREAM_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class JudgeJob:
    """Espejo validado de JudgeJobStreamMessage en packages/shared."""

    schema_version: int
    submission_id: str
    problem_id: str
    problem_version: int
    language: Language
    source_code: str = field(repr=False)
    time_limit_ms: int = 0
    memory_limit_mb: int = 0
    cases_ref: str = field(default="", repr=False)
    enqueued_at_ms: int = 0
    request_id: str | None = None

    def __post_init__(self) -> None:
        if (
            type(self.schema_version) is not int
            or self.schema_version != JUDGE_STREAM_SCHEMA_VERSION
        ):
            raise ValueError("Versión de esquema del trabajo no soportada")
        if any(
            not isinstance(value, str) or not value
            for value in (self.submission_id, self.problem_id, self.cases_ref)
        ):
            raise ValueError("El trabajo requiere identificadores y referencia de casos")
        if type(self.problem_version) is not int or self.problem_version < 1:
            raise ValueError("problem_version debe ser un entero positivo")
        if self.language not in LANGUAGES:
            raise ValueError("Lenguaje no soportado")
        if not isinstance(self.source_code, str):
            raise ValueError("source_code debe ser texto")
        if len(self.source_code.encode("utf-8")) > SOURCE_CODE_MAX_BYTES:
            raise ValueError("El código excede el límite permitido")
        if type(self.time_limit_ms) is not int or self.time_limit_ms < 1:
            raise ValueError("time_limit_ms debe ser un entero positivo")
        if (
            type(self.memory_limit_mb) is not int
            or not 1 <= self.memory_limit_mb <= MEMORY_LIMIT_MB
        ):
            raise ValueError("memory_limit_mb excede el máximo permitido")
        if type(self.enqueued_at_ms) is not int or self.enqueued_at_ms < 1:
            raise ValueError("enqueued_at_ms debe ser un entero positivo")
        if self.request_id is not None and (
            not isinstance(self.request_id, str) or not self.request_id
        ):
            raise ValueError("request_id no puede estar vacío")


@dataclass(frozen=True)
class DurableJudgeResult:
    """Resultado listo para persistir; no contiene casos ni código fuente."""

    submission_id: str
    verdict: Verdict
    passed: int
    total: int
    exec_time_ms: int
    judged_at: int
    compile_output: str | None = None
    judge_error: str | None = None

    def __post_init__(self) -> None:
        if not self.submission_id:
            raise ValueError("submission_id es obligatorio")
        if type(self.passed) is not int or type(self.total) is not int:
            raise ValueError("passed y total deben ser enteros")
        if self.passed < 0 or self.total < 0 or self.passed > self.total:
            raise ValueError("Conteo de casos inválido")
        if type(self.exec_time_ms) is not int or self.exec_time_ms < 0:
            raise ValueError("exec_time_ms debe ser no negativo")
        if type(self.judged_at) is not int or self.judged_at < 1:
            raise ValueError("judged_at debe ser positivo")
        if not isinstance(self.verdict, Verdict):
            raise ValueError("Veredicto inválido")
        if self.compile_output is not None and (
            not isinstance(self.compile_output, str)
            or len(self.compile_output) > MAX_COMPILE_OUTPUT_BYTES
        ):
            raise ValueError("compile_output excede el máximo permitido")
        if self.judge_error is not None and not isinstance(self.judge_error, str):
            raise ValueError("judge_error debe ser texto")

    def to_message(self) -> dict[str, object]:
        """Serializa el contrato sin campos opcionales ausentes ni tipos internos."""
        message: dict[str, object] = {
            "submission_id": self.submission_id,
            "verdict": self.verdict.value,
            "passed": self.passed,
            "total": self.total,
            "exec_time_ms": self.exec_time_ms,
            "judged_at": self.judged_at,
        }
        if self.compile_output is not None:
            message["compile_output"] = self.compile_output
        if self.judge_error is not None:
            message["judge_error"] = self.judge_error
        return message


class CasesProvider(Protocol):
    """Resuelve una referencia autorizada sin entregar paths arbitrarios al sandbox."""

    def load_cases(
        self, cases_ref: str, problem_id: str, problem_version: int
    ) -> Sequence[JudgeCase]: ...


class ArtifactCleaner(Protocol):
    def cleanup(self, artifact_reference: str) -> bool: ...


class JudgePipeline:
    """Procesa un trabajo completo y convierte fallos internos en SE reintentable."""

    def __init__(
        self,
        cases_provider: CasesProvider,
        compiler: CompilationBackend,
        runner: CaseRunner,
        cleaner: ArtifactCleaner,
        clock_ms: Callable[[], int],
    ) -> None:
        self._cases_provider = cases_provider
        self._compiler = compiler
        self._runner = runner
        self._cleaner = cleaner
        self._clock_ms = clock_ms

    def process(self, job: JudgeJob) -> DurableJudgeResult:
        artifact_reference: str | None = None
        total = 0
        result: DurableJudgeResult
        try:
            cases = tuple(
                self._cases_provider.load_cases(job.cases_ref, job.problem_id, job.problem_version)
            )
            _validate_cases(cases)
            total = len(cases)
            prepared = prepare_submission(self._compiler, job.language, job.source_code)
            if not prepared.succeeded:
                if prepared.verdict == Verdict.CE:
                    submission = compilation_error(total)
                    return self._durable(
                        job,
                        submission,
                        compile_output=prepared.compile_output or None,
                    )
                return self._system_error(job, total, prepared.judge_error)

            assert prepared.artifact is not None
            artifact_reference = prepared.artifact.reference
            sandbox = SandboxSpec(
                artifact_reference,
                prepared.run_argv,
                job.time_limit_ms,
                job.memory_limit_mb,
            )
            submission = judge_cases(self._runner, prepared.artifact, sandbox, cases)
            result = self._durable(
                job,
                submission,
                compile_output=prepared.compile_output or None,
            )
        except Exception:
            result = self._system_error(
                job, total, "El pipeline del juez no pudo completar el trabajo"
            )

        if artifact_reference is not None:
            try:
                cleaned = self._cleaner.cleanup(artifact_reference)
            except Exception:
                cleaned = False
            if not cleaned:
                return self._system_error(job, result.total, "No se pudo limpiar el artefacto")
        return result

    def _durable(
        self,
        job: JudgeJob,
        submission: SubmissionResult,
        *,
        compile_output: str | None = None,
    ) -> DurableJudgeResult:
        return DurableJudgeResult(
            submission_id=job.submission_id,
            verdict=submission.verdict,
            passed=submission.passed,
            total=submission.total,
            exec_time_ms=submission.exec_time_ms,
            judged_at=self._now_ms(),
            compile_output=compile_output,
        )

    def _system_error(self, job: JudgeJob, total: int, message: str | None) -> DurableJudgeResult:
        return DurableJudgeResult(
            submission_id=job.submission_id,
            verdict=Verdict.SE,
            passed=0,
            total=total,
            exec_time_ms=0,
            judged_at=self._now_ms(),
            judge_error=message or "Fallo interno del juez",
        )

    def _now_ms(self) -> int:
        value = self._clock_ms()
        if type(value) is not int or value < 1:
            raise ValueError("El reloj debe devolver epoch positivo en milisegundos")
        return value


def _validate_cases(cases: Sequence[JudgeCase]) -> None:
    if not cases:
        raise ValueError("El problema debe contener casos")
    if [case.ordinal for case in cases] != list(range(1, len(cases) + 1)):
        raise ValueError("Los casos deben estar ordenados y ser consecutivos")
