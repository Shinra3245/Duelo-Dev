"""Pruebas de pertenencia, formato y rechazo de symlinks del almacén de casos."""

import json
from pathlib import Path

import pytest

from judge.case_store import DirectoryCasesProvider, MAX_CASE_BYTES, MAX_CASES_PER_PROBLEM


PROBLEM_ID = "550e8400-e29b-41d4-a716-446655440000"


def manifest(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schema_version": 1,
        "problem_id": PROBLEM_ID,
        "problem_version": 1,
        "cases": [
            {"ordinal": 1, "input": "1 2\n", "expected": "3\n"},
            {"ordinal": 2, "input": "-1 1\n", "expected": "0\n"},
        ],
    }
    value.update(changes)
    return value


def write_bundle(root: Path, value: object | None = None) -> Path:
    directory = root / "cases" / PROBLEM_ID / "v1"
    directory.mkdir(parents=True)
    path = directory / "manifest.json"
    path.write_text(json.dumps(manifest() if value is None else value), encoding="utf-8")
    return path


def test_loads_only_requested_version_and_keeps_private_data_out_of_repr(tmp_path: Path) -> None:
    write_bundle(tmp_path)

    cases = DirectoryCasesProvider(tmp_path).load_cases(f"cases/{PROBLEM_ID}", PROBLEM_ID, 1)

    assert [case.ordinal for case in cases] == [1, 2]
    assert cases[0].stdin == b"1 2\n"
    assert cases[0].expected == b"3\n"
    assert "1 2" not in repr(cases)
    assert "3" not in repr(cases)


@pytest.mark.parametrize(
    "reference",
    [
        f"cases/{PROBLEM_ID}/../other",
        f"/cases/{PROBLEM_ID}",
        "cases/other",
        f"cases/{PROBLEM_ID}%2f..",
        f"cases/{PROBLEM_ID}/v1",
    ],
)
def test_rejects_paths_not_equal_to_server_reference(tmp_path: Path, reference: str) -> None:
    write_bundle(tmp_path)

    with pytest.raises(ValueError, match="cases_ref"):
        DirectoryCasesProvider(tmp_path).load_cases(reference, PROBLEM_ID, 1)


@pytest.mark.parametrize("linked_component", ["cases", "problem", "version", "manifest"])
def test_rejects_symlinks_in_every_untrusted_component(
    tmp_path: Path, linked_component: str
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "manifest.json").write_text(json.dumps(manifest()), encoding="utf-8")
    cases_dir = tmp_path / "cases"
    if linked_component == "cases":
        cases_dir.symlink_to(outside, target_is_directory=True)
    else:
        cases_dir.mkdir()

    if linked_component == "problem":
        (cases_dir / PROBLEM_ID).symlink_to(outside, target_is_directory=True)
    else:
        problem_dir = cases_dir / PROBLEM_ID
        problem_dir.mkdir()
        if linked_component == "version":
            (problem_dir / "v1").symlink_to(outside, target_is_directory=True)
        else:
            version_dir = problem_dir / "v1"
            version_dir.mkdir()
            (version_dir / "manifest.json").symlink_to(outside / "manifest.json")

    with pytest.raises(ValueError, match="paquete autorizado"):
        DirectoryCasesProvider(tmp_path).load_cases(f"cases/{PROBLEM_ID}", PROBLEM_ID, 1)


def test_rejects_symlink_as_store_root(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    linked = tmp_path / "linked"
    linked.symlink_to(real, target_is_directory=True)

    with pytest.raises(ValueError, match="directorio real"):
        DirectoryCasesProvider(linked)


@pytest.mark.parametrize(
    "value",
    [
        [],
        {**manifest(), "schema_version": 2},
        {**manifest(), "schema_version": True},
        {**manifest(), "problem_id": "another"},
        {**manifest(), "problem_version": 2},
        {**manifest(), "problem_version": True},
        {**manifest(), "unexpected": True},
        {**manifest(), "cases": []},
        {**manifest(), "cases": [{"ordinal": 2, "input": "", "expected": ""}]},
        {**manifest(), "cases": [{"ordinal": True, "input": "", "expected": ""}]},
        {**manifest(), "cases": [{"ordinal": 1, "input": 3, "expected": ""}]},
    ],
)
def test_rejects_malformed_or_mismatched_manifests(tmp_path: Path, value: object) -> None:
    write_bundle(tmp_path, value)

    with pytest.raises(ValueError):
        DirectoryCasesProvider(tmp_path).load_cases(f"cases/{PROBLEM_ID}", PROBLEM_ID, 1)


def test_rejects_duplicate_json_keys(tmp_path: Path) -> None:
    path = write_bundle(tmp_path)
    path.write_text(
        '{"schema_version":1,"schema_version":1,"problem_id":"'
        + PROBLEM_ID
        + '","problem_version":1,"cases":[]}',
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="duplicadas"):
        DirectoryCasesProvider(tmp_path).load_cases(f"cases/{PROBLEM_ID}", PROBLEM_ID, 1)


def test_rejects_case_larger_than_limit(tmp_path: Path) -> None:
    value = manifest(cases=[{"ordinal": 1, "input": "x" * (MAX_CASE_BYTES + 1), "expected": ""}])
    write_bundle(tmp_path, value)

    with pytest.raises(ValueError, match="tamaño"):
        DirectoryCasesProvider(tmp_path).load_cases(f"cases/{PROBLEM_ID}", PROBLEM_ID, 1)


def test_accepts_at_most_twelve_hidden_cases(tmp_path: Path) -> None:
    cases = [
        {"ordinal": ordinal, "input": str(ordinal), "expected": str(ordinal)}
        for ordinal in range(1, MAX_CASES_PER_PROBLEM + 1)
    ]
    write_bundle(tmp_path, manifest(cases=cases))

    loaded = DirectoryCasesProvider(tmp_path).load_cases(f"cases/{PROBLEM_ID}", PROBLEM_ID, 1)

    assert len(loaded) == MAX_CASES_PER_PROBLEM


def test_rejects_more_cases_than_the_mvp_content_contract(tmp_path: Path) -> None:
    cases = [
        {"ordinal": ordinal, "input": "", "expected": ""}
        for ordinal in range(1, MAX_CASES_PER_PROBLEM + 2)
    ]
    write_bundle(tmp_path, manifest(cases=cases))

    with pytest.raises(ValueError, match="Cantidad"):
        DirectoryCasesProvider(tmp_path).load_cases(f"cases/{PROBLEM_ID}", PROBLEM_ID, 1)


def test_problem_id_cannot_be_a_path_component(tmp_path: Path) -> None:
    write_bundle(tmp_path)

    with pytest.raises(ValueError, match="problem_id"):
        DirectoryCasesProvider(tmp_path).load_cases("cases/../outside", "../outside", 1)
