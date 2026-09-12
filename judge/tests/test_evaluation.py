"""Casos deterministas: no se ejecuta código enviado ni se inicia Docker."""

from dataclasses import asdict

import pytest

from judge.evaluation import (
    CaseExecution,
    CaseResult,
    compilation_error,
    evaluate_case,
    normalize_output,
    summarize,
)
from judge.limits import OUTPUT_LIMIT_BYTES
from judge.verdicts import Verdict


@pytest.mark.parametrize(
    ("actual", "expected", "verdict"),
    [
        (b"42\n", b"42", Verdict.AC),
        (b"42 \t\r\n", b"42\n", Verdict.AC),
        (b"a  b\n", b"a b\n", Verdict.WA),
        (b" 42\n", b"42\n", Verdict.WA),
        (b"42\n\n", b"42\n", Verdict.WA),
        (b"", b"\n", Verdict.AC),
        (b"\xff", b"42", Verdict.WA),
        (b"42\x00", b"42", Verdict.WA),
        ("á\n".encode(), "á".encode(), Verdict.AC),
        (b'{"verdict":"AC"}', b"42", Verdict.WA),
    ],
)
def test_compare(actual: bytes, expected: bytes, verdict: Verdict) -> None:
    assert evaluate_case(CaseExecution(1, actual), expected).verdict == verdict


def test_preserve_empty_internal_lines() -> None:
    assert normalize_output("a\r\n\r\nb \n") == "a\n\nb"


@pytest.mark.parametrize(
    ("execution", "verdict"),
    [
        (CaseExecution(1, b"42", exit_code=1), Verdict.RE),
        (CaseExecution(1, b"42", timed_out=True, exit_code=-9), Verdict.TLE),
        (CaseExecution(1, b"42", oom_killed=True, exit_code=-9), Verdict.MLE),
        (CaseExecution(1, b"42", output_exceeded=True), Verdict.OLE),
        (CaseExecution(1, b"42", system_error=True, timed_out=True), Verdict.SE),
        (CaseExecution(1, b"x" * (OUTPUT_LIMIT_BYTES + 1)), Verdict.OLE),
        (CaseExecution(1, b"42", stderr=b"x" * (OUTPUT_LIMIT_BYTES + 1)), Verdict.OLE),
        (CaseExecution(1, b"42", stderr=b"debug output"), Verdict.AC),
    ],
)
def test_failures_precede_comparison(execution: CaseExecution, verdict: Verdict) -> None:
    assert evaluate_case(execution, b"42").verdict == verdict


def test_output_limit_is_inclusive() -> None:
    text = b"x" * OUTPUT_LIMIT_BYTES
    assert evaluate_case(CaseExecution(1, text), text).verdict == Verdict.AC


@pytest.mark.parametrize("expected", [b"\xffSECRET", b"SECRET\x00"])
def test_invalid_reference_is_not_a_player_failure(expected: bytes) -> None:
    with pytest.raises(ValueError) as error:
        evaluate_case(CaseExecution(1, b""), expected)
    assert "SECRET" not in str(error.value)


def test_summary_uses_case_order_and_counts_later_successes() -> None:
    result = summarize(
        [
            CaseResult(3, Verdict.TLE, 100),
            CaseResult(2, Verdict.AC, 3),
            CaseResult(1, Verdict.WA, 2),
        ],
        3,
    )
    assert asdict(result) == {"verdict": Verdict.WA, "passed": 1, "total": 3, "exec_time_ms": 105}


def test_system_failure_invalidates_entire_judgment() -> None:
    assert (
        summarize([CaseResult(1, Verdict.WA, 1), CaseResult(2, Verdict.SE, 0)], 2).verdict
        == Verdict.SE
    )


def test_all_accepted() -> None:
    assert summarize([CaseResult(1, Verdict.AC, 1)], 1).verdict == Verdict.AC


@pytest.mark.parametrize(
    ("results", "total"),
    [
        ([], 0),
        ([], 2),
        ([CaseResult(1, Verdict.AC, 1)] * 2, 2),
        ([CaseResult(2, Verdict.AC, 1)], 1),
        ([], -1),
        ([], True),
    ],
)
def test_incomplete_or_duplicate_cases_rejected(results: list[CaseResult], total: int) -> None:
    with pytest.raises(ValueError):
        summarize(results, total)


def test_ce_does_not_require_case_execution() -> None:
    assert compilation_error(12).passed == 0
    assert compilation_error(12).total == 12
    assert compilation_error(12).verdict == Verdict.CE


@pytest.mark.parametrize("total", [0, -1, True])
def test_invalid_compilation_total(total: int) -> None:
    with pytest.raises(ValueError):
        compilation_error(total)


def test_results_do_not_contain_case_material() -> None:
    execution = CaseExecution(1, b"SECRET", stderr=b"PRIVATE")
    assert "SECRET" not in repr(execution)
    assert "PRIVATE" not in repr(execution)
    result = evaluate_case(execution, b"EXPECTED")
    assert set(asdict(result)) == {"ordinal", "verdict", "time_ms"}


@pytest.mark.parametrize("ordinal", [0, -1, True])
def test_invalid_ordinal(ordinal: int) -> None:
    with pytest.raises(ValueError):
        CaseExecution(ordinal, b"")


def test_negative_execution_time() -> None:
    with pytest.raises(ValueError):
        CaseExecution(1, b"", time_ms=-1)


def test_ce_cannot_be_a_case_result() -> None:
    with pytest.raises(ValueError):
        CaseResult(1, Verdict.CE, 0)
