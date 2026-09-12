"""El supervisor se prueba sin Docker ni programas enviados."""

from dataclasses import dataclass, field

import pytest

from judge.evaluation import CaseExecution
from judge.sandbox import SandboxSpec
from judge.supervisor import CompiledArtifact, JudgeCase, judge_cases
from judge.verdicts import Verdict


@dataclass
class SpyRunner:
    executions: list[CaseExecution]
    calls: list[tuple[str, tuple[str, ...], bytes, int]] = field(default_factory=list)

    def run_case(
        self, artifact: CompiledArtifact, sandbox: SandboxSpec, stdin: bytes, ordinal: int
    ) -> CaseExecution:
        self.calls.append((artifact.reference, sandbox.command, stdin, ordinal))
        return self.executions[ordinal - 1]


def sandbox() -> SandboxSpec:
    return SandboxSpec("runner@sha256:abc", ("/app/run",), 1000)


def test_runner_receives_only_current_stdin_and_never_expected() -> None:
    secret_expected = b"expected-private-output"
    runner = SpyRunner([CaseExecution(1, b"ok"), CaseExecution(2, secret_expected)])
    result = judge_cases(
        runner,
        CompiledArtifact("artifact-1"),
        sandbox(),
        [JudgeCase(1, b"first-input", b"ok"), JudgeCase(2, b"second-input", secret_expected)],
    )

    assert result.verdict == Verdict.AC
    assert runner.calls == [
        ("artifact-1", ("/app/run",), b"first-input", 1),
        ("artifact-1", ("/app/run",), b"second-input", 2),
    ]
    assert secret_expected.decode() not in repr(runner.calls)
    assert secret_expected.decode() not in repr(result)


def test_all_cases_run_after_a_program_failure() -> None:
    runner = SpyRunner([CaseExecution(1, b"wrong"), CaseExecution(2, b"ok")])

    result = judge_cases(
        runner,
        CompiledArtifact("artifact-1"),
        sandbox(),
        [JudgeCase(1, b"a", b"ok"), JudgeCase(2, b"b", b"ok")],
    )

    assert result.verdict == Verdict.WA
    assert result.passed == 1
    assert [call[3] for call in runner.calls] == [1, 2]


def test_runner_ordinal_mismatch_is_rejected() -> None:
    runner = SpyRunner([CaseExecution(2, b"ok")])
    with pytest.raises(ValueError, match="ordinal distinto"):
        judge_cases(runner, CompiledArtifact("artifact-1"), sandbox(), [JudgeCase(1, b"a", b"ok")])


@pytest.mark.parametrize(
    "cases",
    [[], [JudgeCase(2, b"a", b"b")], [JudgeCase(1, b"a", b"b"), JudgeCase(3, b"a", b"b")]],
)
def test_invalid_case_sequence_is_rejected(cases: list[JudgeCase]) -> None:
    with pytest.raises(ValueError):
        judge_cases(SpyRunner([]), CompiledArtifact("artifact-1"), sandbox(), cases)
