"""El codec rechaza entradas ambiguas sin registrar sus valores."""

from dataclasses import replace

import pytest

from judge.limits import SOURCE_CODE_MAX_BYTES
from judge.pipeline import JudgeJob
from judge.stream_codec import (
    MAX_STREAM_JOB_BYTES,
    MalformedJobError,
    decode_stream_fields,
    encode_stream_fields,
)


def valid_job() -> JudgeJob:
    return JudgeJob(
        schema_version=1,
        submission_id="submission-1",
        problem_id="problem-1",
        problem_version=1,
        language="python",
        source_code="print('á')",
        time_limit_ms=3000,
        memory_limit_mb=256,
        cases_ref="cases/problem-1",
        enqueued_at_ms=1_700_000_000_000,
        request_id="request-1",
    )


def test_round_trip_accepts_redis_bytes_and_unicode_source() -> None:
    expected = valid_job()
    encoded = {
        key.encode(): value.encode() for key, value in encode_stream_fields(expected).items()
    }

    assert decode_stream_fields(encoded) == expected


def test_optional_request_id_is_omitted_canonically() -> None:
    expected = replace(valid_job(), request_id=None)

    encoded = encode_stream_fields(expected)

    assert "request_id" not in encoded
    assert decode_stream_fields(encoded) == expected


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema_version", "01"),
        ("problem_version", "-1"),
        ("time_limit_ms", "1.0"),
        ("memory_limit_mb", "true"),
        ("enqueued_at_ms", "+1"),
    ],
)
def test_rejects_noncanonical_integer_fields(field: str, value: str) -> None:
    encoded = encode_stream_fields(valid_job())
    encoded[field] = value

    with pytest.raises(MalformedJobError, match=field):
        decode_stream_fields(encoded)


def test_rejects_missing_and_unknown_fields() -> None:
    missing = encode_stream_fields(valid_job())
    missing.pop("submission_id")
    with pytest.raises(MalformedJobError, match="obligatorios"):
        decode_stream_fields(missing)

    unknown = encode_stream_fields(valid_job())
    unknown["source_path"] = "/host/private"
    with pytest.raises(MalformedJobError, match="desconocidos") as captured:
        decode_stream_fields(unknown)
    assert "/host/private" not in str(captured.value)


def test_rejects_duplicate_keys_after_bytes_normalization() -> None:
    encoded: dict[object, object] = {}
    for key, value in encode_stream_fields(valid_job()).items():
        encoded[key] = value
    encoded[b"submission_id"] = b"another"

    with pytest.raises(MalformedJobError, match="duplicadas"):
        decode_stream_fields(encoded)


def test_invalid_utf8_and_nontext_values_are_rejected_without_echo() -> None:
    invalid_utf8 = dict[object, object](encode_stream_fields(valid_job()))
    invalid_utf8["source_code"] = b"private\xffsource"
    with pytest.raises(MalformedJobError, match="UTF-8") as captured:
        decode_stream_fields(invalid_utf8)
    assert "private" not in str(captured.value)

    invalid_type = dict[object, object](encode_stream_fields(valid_job()))
    invalid_type["source_code"] = {"secret": True}
    with pytest.raises(MalformedJobError, match="bytes o texto") as captured:
        decode_stream_fields(invalid_type)
    assert "secret" not in str(captured.value)


def test_source_and_whole_message_limits_count_utf8_bytes() -> None:
    encoded = encode_stream_fields(valid_job())
    encoded["source_code"] = "á" * (SOURCE_CODE_MAX_BYTES // 2 + 1)

    with pytest.raises(MalformedJobError, match="código excede"):
        decode_stream_fields(encoded)

    oversized = encode_stream_fields(valid_job())
    oversized["request_id"] = "x" * MAX_STREAM_JOB_BYTES
    with pytest.raises(MalformedJobError, match="entrada del stream excede"):
        decode_stream_fields(oversized)


def test_job_validation_errors_never_include_source() -> None:
    private_source = "TOP_SECRET_SOURCE"
    encoded = encode_stream_fields(valid_job())
    encoded["source_code"] = private_source
    encoded["language"] = "ruby"

    with pytest.raises(MalformedJobError) as captured:
        decode_stream_fields(encoded)

    assert private_source not in str(captured.value)
