"""Contratos puros de compilación; no invocan compiladores."""

from judge.languages import compile_timeout_ms, runtime_for


def test_python_does_not_compile() -> None:
    runtime = runtime_for("python")
    assert runtime.source_name == "main.py"
    assert runtime.compile_argv is None
    assert runtime.run_argv == ("python3", "/app/main.py")
    assert compile_timeout_ms("python") == 0


def test_compiled_languages_use_fixed_paths_and_no_shell() -> None:
    cpp = runtime_for("cpp")
    java = runtime_for("java")

    assert cpp.compile_argv is not None and "/app/main.cpp" in cpp.compile_argv
    assert cpp.run_argv == ("/out/main",)
    assert java.compile_argv is not None and "/app/Main.java" in java.compile_argv
    assert java.run_argv == ("java", "-cp", "/out", "Main")
    assert compile_timeout_ms("cpp") > 0
    assert compile_timeout_ms("java") > 0
