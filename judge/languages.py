"""Comandos confiables por lenguaje; nunca incorporan código en un shell."""

from dataclasses import dataclass
from typing import Final

from judge.limits import COMPILE_TIMEOUT_MS, Language


@dataclass(frozen=True)
class LanguageRuntime:
    source_name: str
    compile_argv: tuple[str, ...] | None
    run_argv: tuple[str, ...]


LANGUAGE_RUNTIMES: Final[dict[Language, LanguageRuntime]] = {
    "python": LanguageRuntime("main.py", None, ("python3", "/app/main.py")),
    "cpp": LanguageRuntime(
        "main.cpp",
        ("g++", "-std=c++20", "-O2", "-pipe", "/app/main.cpp", "-o", "/out/main"),
        ("/out/main",),
    ),
    "java": LanguageRuntime(
        "Main.java",
        ("javac", "-d", "/out", "/app/Main.java"),
        ("java", "-cp", "/out", "Main"),
    ),
}


def runtime_for(language: Language) -> LanguageRuntime:
    return LANGUAGE_RUNTIMES[language]


def compile_timeout_ms(language: Language) -> int:
    return COMPILE_TIMEOUT_MS[language]
