"""La validación del catálogo no ejecuta código de participantes en estos unitarios."""

from pathlib import Path

import pytest

from judge.catalog_smoke import reference_source, run_catalog
from judge.limits import Language


@pytest.mark.parametrize(
    "language,filename", [("python", "solution.py"), ("cpp", "main.cpp"), ("java", "Main.java")]
)
def test_reference_marker_is_replaced(tmp_path: Path, language: Language, filename: str) -> None:
    (tmp_path / filename).write_text('solve("__PROBLEM_SLUG__")', encoding="utf-8")
    prefix = "#define REF_palindromo 1\n" if language == "cpp" else ""
    assert reference_source(tmp_path, language, "palindromo") == prefix + 'solve("palindromo")'


@pytest.mark.parametrize("slug", ["", "../secret", "palindromo';exit", "x/y"])
def test_reference_rejects_unsafe_slug(tmp_path: Path, slug: str) -> None:
    with pytest.raises(ValueError, match="Slug"):
        reference_source(tmp_path, "python", slug)


@pytest.mark.parametrize("template", ["no marker", "__PROBLEM_SLUG____PROBLEM_SLUG__"])
def test_reference_requires_single_marker(tmp_path: Path, template: str) -> None:
    (tmp_path / "solution.py").write_text(template, encoding="utf-8")
    with pytest.raises(ValueError, match="único"):
        reference_source(tmp_path, "python", "palindromo")


def test_catalog_cannot_succeed_with_no_problems(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="treinta"):
        run_catalog(tmp_path, [])
