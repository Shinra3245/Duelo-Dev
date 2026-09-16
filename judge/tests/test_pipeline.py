"""Pruebas del pipeline completo con fronteras inyectadas y sin Docker."""

from dataclasses import dataclass, field

import pytest

from judge.compiler import CompilationObservation, CompilationRequest
from judge.evaluation import CaseExecution
from judge.pipeline import DurableJudgeResult, JudgeJob, JudgePipeline
from judge.sandbox import SandboxSpec
from judge.supervisor import CompiledArtifact, JudgeCase
from judge.verdicts import Verdict


ARTIFACT = "sha256:" + "a" * 64


@dataclass
class FakeCasesProvider:
    cases: list[JudgeCase] = field(default_factory=lambda: [JudgeCase(1, b"41\n", b"42\n")])
    error: Exception | None = None

    def load_cases(self, cases_ref: str, problem_id: str, problem_version: int) -> list[JudgeCase]:
        if self.error:
            raise self.error
        return self.cases


@dataclass
class FakeCompiler:
    observation: CompilationObservation
    calls: int = 0

    def prepare(self, request: CompilationRequest) -> CompilationObservation:
        self.calls += 1
        return self.observation


@dataclass
class FakeRunner:
    executions: list[CaseExecution]
    error: Exception | None = None

    def run_case(
        self, artifact: CompiledArtifact, sandbox: SandboxSpec, stdin: bytes, ordinal: int
    ) -> CaseExecution:
        if self.error:
            raise self.error
        return self.executions[ordinal - 1]


@dataclass
class FakeCleaner:
    succeeds: bool = True
    error: Exception | None = None
    references: list[str] = field(default_factory=list)

    def cleanup(self, artifact_reference: str) -> bool:
        self.references.append(artifact_reference)
        if self.error:
            raise self.error
        return self.succeeds


def job(**changes: object) -> JudgeJob:
    values: dict[str, object] = {
        "schema_version": 1,
        "submission_id": "submission-1",
        "problem_id": "problem-1",
        "problem_version": 1,
        "language": "cpp",
        "source_code": "int main(){}",
        "time_limit_ms": 1000,
        "memory_limit_mb": 256,
        "cases_ref": "problem-1/v1",
        "enqueued_at_ms": 1_700_000_000_000,
    }
    values.update(changes)
    return JudgeJob(**values)  # type: ignore[arg-type]


def pipeline(
    compiler: FakeCompiler,
    *,
    provider: FakeCasesProvider | None = None,
    runner: FakeRunner | None = None,
    cleaner: FakeCleaner | None = None,
) -> tuple[JudgePipeline, FakeCleaner]:
    actual_cleaner = cleaner or FakeCleaner()
    return (
        JudgePipeline(
            provider or FakeCasesProvider(),
            compiler,
            runner or FakeRunner([CaseExecution(1, b"42\n", time_ms=7)]),
            actual_cleaner,
            lambda: 1_700_000_000_100,
        ),
        actual_cleaner,
    )


def test_successful_job_returns_durable_result_and_always_cleans() -> None:
    subject, cleaner = pipeline(FakeCompiler(CompilationObservation(ARTIFACT)))

    result = subject.process(job())

    assert result == DurableJudgeResult("submission-1", Verdict.AC, 1, 1, 7, 1_700_000_000_100)
    assert result.to_message() == {
        "submission_id": "submission-1",
        "verdict": "AC",
        "passed": 1,
        "total": 1,
        "exec_time_ms": 7,
        "judged_at": 1_700_000_000_100,
    }
    assert cleaner.references == [ARTIFACT]
    assert "source_code" not in repr(result)


def test_compilation_error_does_not_run_or_create_cleanup_work() -> None:
    runner = FakeRunner([], RuntimeError("must not run"))
    subject, cleaner = pipeline(
        FakeCompiler(CompilationObservation(None, stderr=b"syntax error", exit_code=1)),
        runner=runner,
    )

    result = subject.process(job())

    assert result.verdict == Verdict.CE
    assert result.passed == 0 and result.total == 1
    assert result.compile_output == "syntax error"
    assert result.judge_error is None
    assert cleaner.references == []


def test_compiler_system_error_is_internal_and_hides_raw_output() -> None:
    subject, _ = pipeline(
        FakeCompiler(CompilationObservation(None, stderr=b"private daemon path", system_error=True))
    )

    result = subject.process(job())

    assert result.verdict == Verdict.SE
    assert result.total == 1
    assert result.compile_output is None
    assert "private daemon path" not in repr(result)


def test_runner_failure_still_cleans_artifact() -> None:
    subject, cleaner = pipeline(
        FakeCompiler(CompilationObservation(ARTIFACT)),
        runner=FakeRunner([], RuntimeError("runner crashed with private data")),
    )

    result = subject.process(job())

    assert result.verdict == Verdict.SE
    assert cleaner.references == [ARTIFACT]
    assert "private data" not in (result.judge_error or "")


@pytest.mark.parametrize("raises", [False, True])
def test_cleanup_failure_invalidates_otherwise_successful_judgment(raises: bool) -> None:
    cleaner = FakeCleaner(succeeds=False, error=OSError("disk") if raises else None)
    subject, _ = pipeline(FakeCompiler(CompilationObservation(ARTIFACT)), cleaner=cleaner)

    result = subject.process(job())

    assert result.verdict == Verdict.SE
    assert result.passed == 0 and result.total == 1
    assert result.judge_error == "No se pudo limpiar el artefacto"


def test_cases_failure_becomes_se_without_compiling() -> None:
    compiler = FakeCompiler(CompilationObservation(ARTIFACT))
    subject, cleaner = pipeline(
        compiler, provider=FakeCasesProvider(error=ValueError("invalid path with secret"))
    )

    result = subject.process(job())

    assert result.verdict == Verdict.SE and result.total == 0
    assert compiler.calls == 0
    assert cleaner.references == []
    assert "secret" not in (result.judge_error or "")


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"schema_version": 2}, "esquema"),
        ({"language": "ruby"}, "Lenguaje"),
        ({"time_limit_ms": 0}, "time_limit"),
        ({"memory_limit_mb": 257}, "memory_limit"),
        ({"cases_ref": ""}, "referencia"),
    ],
)
def test_corrupt_jobs_are_rejected_before_pipeline(change: dict[str, object], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        job(**change)
