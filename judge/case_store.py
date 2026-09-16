"""Proveedor cerrado de casos versionados para el worker del juez."""

from collections.abc import Sequence
import json
import os
from pathlib import Path
import re
import stat
from typing import Any, Final

from judge.supervisor import JudgeCase


CASE_BUNDLE_SCHEMA_VERSION: Final[int] = 1
MAX_CASES_PER_PROBLEM: Final[int] = 12
MAX_CASE_BYTES: Final[int] = 1024 * 1024
MAX_MANIFEST_BYTES: Final[int] = 16 * 1024 * 1024
_IDENTIFIER: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_DIRECTORY_FLAGS: Final[int] = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
_FILE_FLAGS: Final[int] = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW


class DirectoryCasesProvider:
    """Lee únicamente `cases/<problem_id>/v<version>/manifest.json` bajo una raíz fija."""

    def __init__(self, root: Path) -> None:
        if not isinstance(root, Path):
            raise ValueError("La raíz de casos debe ser Path")
        try:
            metadata = root.lstat()
        except OSError as error:
            raise ValueError("La raíz de casos no está disponible") from error
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("La raíz de casos debe ser un directorio real")
        self._root = root.resolve(strict=True)

    def load_cases(
        self, cases_ref: str, problem_id: str, problem_version: int
    ) -> Sequence[JudgeCase]:
        _validate_reference(cases_ref, problem_id, problem_version)
        descriptors: list[int] = []
        try:
            current = os.open(self._root, _DIRECTORY_FLAGS)
            descriptors.append(current)
            for component in ("cases", problem_id, f"v{problem_version}"):
                current = os.open(component, _DIRECTORY_FLAGS, dir_fd=current)
                descriptors.append(current)
            manifest_fd = os.open("manifest.json", _FILE_FLAGS, dir_fd=current)
            descriptors.append(manifest_fd)
            raw = _read_bounded(manifest_fd)
        except OSError as error:
            raise ValueError("No se pudo abrir el paquete autorizado de casos") from error
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)

        manifest = _decode_manifest(raw)
        return _manifest_cases(manifest, problem_id, problem_version)


def _validate_reference(cases_ref: str, problem_id: str, problem_version: int) -> None:
    if not isinstance(problem_id, str) or not _IDENTIFIER.fullmatch(problem_id):
        raise ValueError("problem_id no es un identificador permitido")
    if type(problem_version) is not int or problem_version < 1:
        raise ValueError("problem_version debe ser positivo")
    if not isinstance(cases_ref, str) or cases_ref != f"cases/{problem_id}":
        raise ValueError("cases_ref no corresponde al problema autorizado")


def _read_bounded(descriptor: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while chunk := os.read(descriptor, min(64 * 1024, MAX_MANIFEST_BYTES + 1 - size)):
        size += len(chunk)
        if size > MAX_MANIFEST_BYTES:
            raise ValueError("El manifiesto de casos excede el máximo")
        chunks.append(chunk)
    return b"".join(chunks)


def _decode_manifest(raw: bytes) -> dict[str, object]:
    try:
        decoded = raw.decode("utf-8")
        value = json.loads(decoded, object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("El manifiesto de casos no es JSON UTF-8 válido") from error
    if not isinstance(value, dict):
        raise ValueError("El manifiesto debe ser un objeto")
    if set(value) != {"schema_version", "problem_id", "problem_version", "cases"}:
        raise ValueError("El manifiesto contiene campos inesperados o incompletos")
    return value


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("El manifiesto contiene claves duplicadas")
        result[key] = value
    return result


def _manifest_cases(
    manifest: dict[str, object], problem_id: str, problem_version: int
) -> tuple[JudgeCase, ...]:
    if (
        type(manifest["schema_version"]) is not int
        or manifest["schema_version"] != CASE_BUNDLE_SCHEMA_VERSION
    ):
        raise ValueError("Versión de esquema de casos no soportada")
    if (
        manifest["problem_id"] != problem_id
        or type(manifest["problem_version"]) is not int
        or manifest["problem_version"] != problem_version
    ):
        raise ValueError("El paquete no corresponde al problema solicitado")
    raw_cases = manifest["cases"]
    if not isinstance(raw_cases, list) or not 1 <= len(raw_cases) <= MAX_CASES_PER_PROBLEM:
        raise ValueError("Cantidad de casos inválida")

    cases: list[JudgeCase] = []
    for expected_ordinal, raw_case in enumerate(raw_cases, start=1):
        if not isinstance(raw_case, dict) or set(raw_case) != {"ordinal", "input", "expected"}:
            raise ValueError("Caso incompleto o con campos inesperados")
        if type(raw_case["ordinal"]) is not int or raw_case["ordinal"] != expected_ordinal:
            raise ValueError("Los ordinales deben ser consecutivos y ordenados")
        stdin = _case_text(raw_case["input"], "input")
        expected = _case_text(raw_case["expected"], "expected")
        cases.append(JudgeCase(expected_ordinal, stdin, expected))
    return tuple(cases)


def _case_text(value: object, field_name: str) -> bytes:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} debe ser texto")
    encoded = value.encode("utf-8")
    if len(encoded) > MAX_CASE_BYTES:
        raise ValueError(f"{field_name} excede el tamaño permitido")
    return encoded
