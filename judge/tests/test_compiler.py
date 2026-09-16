"""La orquestación de compilación se prueba sin invocar Docker ni código enviado."""

from dataclasses import dataclass

import pytest

from judge.compiler import (
    MAX_COMPILE_OUTPUT_BYTES,
    CompilationObservation,
    CompilationRequest,
    compilation_request,
    prepare_submission,
)
from judge.limits import SOURCE_CODE_MAX_BYTES
from judge.verdicts import Verdict


@dataclass
class FakeBackend:
    observation: CompilationObservation
    request: CompilationRequest | None = None

    def prepare(self, request: CompilationRequest) -> CompilationObservation:
        self.request = request
        return self.observation


def test_cpp_source_is_data_and_commands_are_fixed() -> None:
    source = "int main(){return 0;} && rm -rf /"
    backend = FakeBackend(CompilationObservation("sha256:" + "a" * 64))

    result = prepare_submission(backend, "cpp", source)

    assert result.succeeded
    assert result.artifact is not None
    assert result.artifact.reference == "sha256:" + "a" * 64
    assert result.run_argv == ("/out/main",)
    assert backend.request is not None
    assert backend.request.source == source.encode()
    assert source not in backend.request.compile_argv  # type: ignore[operator]
    assert source not in repr(backend.request)


def test_python_is_packaged_without_compilation() -> None:
    backend = FakeBackend(CompilationObservation("sha256:" + "b" * 64))

    result = prepare_submission(backend, "python", "print('ok')")

    assert result.succeeded
    assert backend.request is not None
    assert backend.request.compile_argv is None
    assert backend.request.timeout_ms == 0
    assert result.run_argv == ("python3", "/app/main.py")


@pytest.mark.parametrize("condition", ["exit", "timeout", "output"])
def test_compiler_failures_are_ce(condition: str) -> None:
    observation = CompilationObservation(
        None,
        stderr=b"diagnostico",
        exit_code=1 if condition == "exit" else 0,
        timed_out=condition == "timeout",
        output_exceeded=condition == "output",
    )

    result = prepare_submission(FakeBackend(observation), "java", "class Main {}")

    assert not result.succeeded
    assert result.verdict == Verdict.CE
    assert result.compile_output == "diagnostico"
    assert result.judge_error is None


def test_system_failure_is_se_and_not_ce() -> None:
    result = prepare_submission(
        FakeBackend(CompilationObservation(None, stderr=b"daemon unavailable", system_error=True)),
        "cpp",
        "int main() {}",
    )

    assert result.verdict == Verdict.SE
    assert result.judge_error is not None


def test_interpreted_packaging_failure_is_se() -> None:
    result = prepare_submission(
        FakeBackend(CompilationObservation(None, exit_code=1)), "python", "print('ok')"
    )

    assert result.verdict == Verdict.SE
    assert result.judge_error is not None


def test_missing_artifact_is_se() -> None:
    result = prepare_submission(FakeBackend(CompilationObservation(None)), "cpp", "int main() {}")

    assert result.verdict == Verdict.SE
    assert result.judge_error is not None


def test_compile_output_is_utf8_safe_and_bounded() -> None:
    output = b"x" * MAX_COMPILE_OUTPUT_BYTES + b"extra\xff"
    result = prepare_submission(
        FakeBackend(CompilationObservation(None, stderr=output, exit_code=1)),
        "cpp",
        "invalid",
    )

    assert len(result.compile_output.encode()) == MAX_COMPILE_OUTPUT_BYTES
    assert "extra" not in result.compile_output


def test_source_limit_counts_utf8_bytes() -> None:
    with pytest.raises(ValueError, match="excede"):
        compilation_request("python", "á" * (SOURCE_CODE_MAX_BYTES // 2 + 1))


def test_invalid_language_is_rejected_before_backend() -> None:
    backend = FakeBackend(CompilationObservation("sha256:" + "c" * 64))

    with pytest.raises(ValueError, match="Lenguaje"):
        prepare_submission(backend, "ruby", "puts 'ok'")  # type: ignore[arg-type]

    assert backend.request is None
