"""Verifica las referencias con el pipeline real; invocar solo dentro de la VM rootless."""

from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
from time import time
from typing import cast

from judge.case_store import DirectoryCasesProvider
from judge.compiler import MAX_COMPILE_OUTPUT_BYTES, CompilationObservation, CompilationRequest
from judge.docker_compiler import DockerCompilationBackend
from judge.docker_session import DockerSessionBackend
from judge.limits import Language, resolve_time_limit_ms
from judge.pipeline import JudgeJob, JudgePipeline
from judge.runtime import DockerCaseRunner, SubprocessDockerInvoker
from judge.session_runtime import DockerSubmissionRunner
from judge.verdicts import Verdict


REFERENCE_FILES: Mapping[Language, str] = {
    "python": "solution.py",
    "cpp": "main.cpp",
    "java": "Main.java",
}


class CatalogCompilationBackend(DockerCompilationBackend):
    def prepare(self, request: CompilationRequest) -> CompilationObservation:
        result = super().prepare(request)
        if result.artifact_reference is None:
            print(
                f"Compilación {request.language}: exit={result.exit_code}, "
                f"timeout={result.timed_out}, overflow={result.output_exceeded}, "
                f"system_error={result.system_error}",
                flush=True,
            )
        return result


def reference_source(root: Path, language: Language, slug: str) -> str:
    if not slug or any(char not in "abcdefghijklmnopqrstuvwxyz0123456789-" for char in slug):
        raise ValueError("Slug de referencia inválido")
    template = (root / REFERENCE_FILES[language]).read_text(encoding="utf-8")
    if template.count("__PROBLEM_SLUG__") != 1:
        raise ValueError("La referencia debe contener un único marcador de reto")
    source = template.replace("__PROBLEM_SLUG__", slug)
    if language == "cpp":
        source = f"#define REF_{slug.replace('-', '_')} 1\n{source}"
    return source


def image_digest(tag: str) -> str:
    digest = subprocess.check_output(
        ["docker", "image", "inspect", tag, "--format", "{{index .RepoDigests 0}}"], text=True
    ).strip()
    if "@sha256:" not in digest:
        raise ValueError("El toolchain debe estar fijado a un digest")
    return digest


def run_catalog(root: Path, catalog: Sequence[Mapping[str, object]]) -> None:
    if len(catalog) != 30 or len({str(problem["problem_id"]) for problem in catalog}) != 30:
        raise ValueError("Se requieren los treinta retos activos, sin duplicados")
    security = subprocess.check_output(
        ["docker", "info", "--format", "{{json .SecurityOptions}}"], text=True
    )
    if "name=rootless" not in json.loads(security):
        raise RuntimeError("Se requiere Docker rootless dentro de la VM")
    images: dict[Language, str] = {
        "python": image_digest("python:3.12-slim-bookworm"),
        "cpp": image_digest("gcc:14-bookworm"),
        "java": image_digest("eclipse-temurin:21-jdk-jammy"),
    }
    invoker = SubprocessDockerInvoker(MAX_COMPILE_OUTPUT_BYTES)
    backend = CatalogCompilationBackend(invoker, images)
    provider = DirectoryCasesProvider(root / "problems")
    pipeline = JudgePipeline(
        provider,
        backend,
        DockerCaseRunner(invoker),
        backend,
        lambda: int(time() * 1000),
        submission_runner=DockerSubmissionRunner(DockerSessionBackend(invoker)),
    )
    checked = 0
    with ThreadPoolExecutor(max_workers=3) as pool:
        for problem in catalog:
            problem_id = str(problem["problem_id"])
            version = cast(int, problem["version"])
            if len(provider.load_cases(f"cases/{problem_id}", problem_id, version)) != 12:
                raise AssertionError(f"{problem['slug']}: se requieren doce casos congelados")
            tasks = [
                pool.submit(check_reference, pipeline, root, problem, language)
                for language in REFERENCE_FILES
            ]
            for task in tasks:
                task.result()
                checked += 1
    print(
        f"Catálogo verificado: {checked} envíos, {checked * 12} casos; sin alterar datos históricos."
    )


def check_reference(
    pipeline: JudgePipeline, root: Path, problem: Mapping[str, object], language: Language
) -> None:
    slug = str(problem["slug"])
    problem_id = str(problem["problem_id"])
    result = pipeline.process(
        JudgeJob(
            schema_version=1,
            submission_id=f"catalog-{slug}-{language}",
            problem_id=problem_id,
            problem_version=cast(int, problem["version"]),
            language=language,
            source_code=reference_source(root / "problems" / "reference-solutions", language, slug),
            time_limit_ms=resolve_time_limit_ms(cast(int, problem["time_limit_ms"]), language),
            memory_limit_mb=cast(int, problem["memory_limit_mb"]),
            cases_ref=f"cases/{problem_id}",
            enqueued_at_ms=int(time() * 1000),
        )
    )
    print(f"{slug} {language}: {result.verdict.value} {result.passed}/{result.total}", flush=True)
    if result.verdict != Verdict.AC or result.passed != 12 or result.total != 12:
        raise AssertionError(
            f"Referencia fallida: {slug}/{language}; {result.judge_error or result.compile_output or result.verdict.value}"
        )


if __name__ == "__main__":
    run_catalog(Path.cwd(), json.load(sys.stdin))
