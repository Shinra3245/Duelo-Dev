"""Codec estricto para entradas planas de Redis Stream del juez."""

from collections.abc import Mapping
import re
from typing import Any, Final

from judge.limits import SOURCE_CODE_MAX_BYTES
from judge.pipeline import JudgeJob


MAX_STREAM_JOB_BYTES: Final[int] = SOURCE_CODE_MAX_BYTES + 8 * 1024
_INTEGER: Final[re.Pattern[str]] = re.compile(r"^(?:0|[1-9][0-9]*)$")
_REQUIRED_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "schema_version",
        "submission_id",
        "problem_id",
        "problem_version",
        "language",
        "source_code",
        "time_limit_ms",
        "memory_limit_mb",
        "cases_ref",
        "enqueued_at_ms",
    }
)
_OPTIONAL_FIELDS: Final[frozenset[str]] = frozenset({"request_id"})
_KNOWN_FIELDS: Final[frozenset[str]] = _REQUIRED_FIELDS | _OPTIONAL_FIELDS


class MalformedJobError(ValueError):
    """Error saneado que nunca incluye valores recibidos ni código fuente."""


def decode_stream_fields(fields: Mapping[Any, Any]) -> JudgeJob:
    """Convierte campos bytes/string de XREADGROUP al contrato validado del pipeline."""
    if not isinstance(fields, Mapping):
        raise MalformedJobError("La entrada del stream no es un mapa")
    decoded: dict[str, str] = {}
    total_bytes = 0
    for raw_key, raw_value in fields.items():
        key, key_size = _decode_text(raw_key, "clave")
        value, value_size = _decode_text(raw_value, "valor")
        total_bytes += key_size + value_size
        if total_bytes > MAX_STREAM_JOB_BYTES:
            raise MalformedJobError("La entrada del stream excede el tamaño permitido")
        if key in decoded:
            raise MalformedJobError("La entrada contiene claves duplicadas")
        if key not in _KNOWN_FIELDS:
            raise MalformedJobError("La entrada contiene campos desconocidos")
        decoded[key] = value

    missing = _REQUIRED_FIELDS - decoded.keys()
    if missing:
        raise MalformedJobError("La entrada no contiene todos los campos obligatorios")

    try:
        return JudgeJob(
            schema_version=_integer(decoded["schema_version"], "schema_version"),
            submission_id=decoded["submission_id"],
            problem_id=decoded["problem_id"],
            problem_version=_integer(decoded["problem_version"], "problem_version"),
            language=decoded["language"],  # type: ignore[arg-type]
            source_code=decoded["source_code"],
            time_limit_ms=_integer(decoded["time_limit_ms"], "time_limit_ms"),
            memory_limit_mb=_integer(decoded["memory_limit_mb"], "memory_limit_mb"),
            cases_ref=decoded["cases_ref"],
            enqueued_at_ms=_integer(decoded["enqueued_at_ms"], "enqueued_at_ms"),
            request_id=decoded.get("request_id"),
        )
    except ValueError as error:
        raise MalformedJobError(str(error)) from None


def encode_stream_fields(job: JudgeJob) -> dict[str, str]:
    """Codificación canónica plana para productores y fixtures de integración."""
    fields = {
        "schema_version": str(job.schema_version),
        "submission_id": job.submission_id,
        "problem_id": job.problem_id,
        "problem_version": str(job.problem_version),
        "language": job.language,
        "source_code": job.source_code,
        "time_limit_ms": str(job.time_limit_ms),
        "memory_limit_mb": str(job.memory_limit_mb),
        "cases_ref": job.cases_ref,
        "enqueued_at_ms": str(job.enqueued_at_ms),
    }
    if job.request_id is not None:
        fields["request_id"] = job.request_id
    return fields


def _decode_text(value: object, kind: str) -> tuple[str, int]:
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8"), len(value)
        except UnicodeDecodeError:
            raise MalformedJobError(f"La {kind} no es UTF-8 válido") from None
    if isinstance(value, str):
        return value, len(value.encode("utf-8"))
    raise MalformedJobError(f"La {kind} debe ser bytes o texto")


def _integer(value: str, field_name: str) -> int:
    if not _INTEGER.fullmatch(value):
        raise MalformedJobError(f"{field_name} debe ser un entero decimal canónico")
    return int(value)
