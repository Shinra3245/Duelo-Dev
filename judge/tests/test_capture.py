"""La captura no inicia procesos ni escribe archivos temporales."""

import pytest

from judge.capture import BoundedCapture


def test_capture_keeps_only_the_configured_limit() -> None:
    capture = BoundedCapture(5)
    capture.append(b"abc")
    capture.append(b"def")

    assert capture.data == b"abcde"
    assert capture.exceeded


def test_capture_marks_excess_after_reaching_the_limit() -> None:
    capture = BoundedCapture(2)
    capture.append(b"ab")
    capture.append(b"c")

    assert capture.data == b"ab"
    assert capture.exceeded


@pytest.mark.parametrize("limit", [0, -1, True])
def test_invalid_limit_is_rejected(limit: int) -> None:
    with pytest.raises(ValueError):
        BoundedCapture(limit)


def test_non_bytes_chunk_is_rejected() -> None:
    with pytest.raises(ValueError):
        BoundedCapture(1).append("x")  # type: ignore[arg-type]
