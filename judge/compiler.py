"""Orquestación confiable de compilación y preparación de artefactos.

Este módulo no ejecuta compiladores directamente. Construye una solicitud cerrada para
un backend aislado y clasifica su observación sin interpolar código en comandos ni exponer
el contenido enviado en resultados o representaciones.
"""

from dataclasses import dataclass, field
from pathlib import PurePath
from typing import Protocol

from judge.languages import compile_timeout_ms, runtime_for
from judge.limits import LANGUAGES, SOURCE_CODE_MAX_BYTES, Language
from judge.supervisor import CompiledArtifact
from judge.verdicts import Verdict


MAX_COMPILE_OUTPUT_BYTES = 4 * 1024


@dataclass(frozen=True)
class CompilationRequest:
    """Entrada cerrada para el backend; el código siempre viaja como datos."""

    language: Language
    source_name: str
    source: bytes = field(repr=False)
    compile_argv: tuple[str, ...] | None = None
    run_argv: tuple[str, ...] = ()
    timeout_ms: int = 0

    def __post_init__(self) -> None:
        if self.language not in LANGUAGES:
            raise ValueError("Lenguaje no soportado")
        if (
            not self.source_name
            or PurePath(self.source_name).name != self.source_name
            or self.source_name in {".", ".."}
            or not isinstance(self.source, bytes)
        ):
            raise ValueError("La fuente debe tener nombre y contenido binario")
        if len(self.source) > SOURCE_CODE_MAX_BYTES:
            raise ValueError("El código excede el límite permitido")
        if not self.run_argv or any(not part for part in self.run_argv):
            raise ValueError("El comando de ejecución es obligatorio")
        if self.compile_argv is None:
            if self.timeout_ms != 0:
                raise ValueError("Un lenguaje interpretado no tiene timeout de compilación")
        elif self.timeout_ms < 1 or any(not part for part in self.compile_argv):
            raise ValueError("La compilación requiere comando y timeout válidos")


@dataclass(frozen=True)
class CompilationObservation:
    """Datos confiables devueltos por el backend aislado."""

    artifact_reference: str | None
    stdout: bytes = field(default=b"", repr=False)
    stderr: bytes = field(default=b"", repr=False)
    exit_code: int = 0
    timed_out: bool = False
    output_exceeded: bool = False
    system_error: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.stdout, bytes) or not isinstance(self.stderr, bytes):
            raise ValueError("Las salidas de compilación deben ser bytes")
        if type(self.exit_code) is not int:
            raise ValueError("exit_code debe ser entero")
        if self.artifact_reference is not None and not self.artifact_reference:
            raise ValueError("La referencia del artefacto no puede estar vacía")


class CompilationBackend(Protocol):
    """Backend aislado que prepara un artefacto ejecutable por envío."""

    def prepare(self, request: CompilationRequest) -> CompilationObservation: ...


@dataclass(frozen=True)
class CompilationResult:
    """Resultado normalizado que consumirá el worker del juez."""

    artifact: CompiledArtifact | None
    run_argv: tuple[str, ...]
    verdict: Verdict | None = None
    compile_output: str = ""
    judge_error: str | None = None

    @property
    def succeeded(self) -> bool:
        return self.artifact is not None and self.verdict is None


def compilation_request(language: Language, source_code: str) -> CompilationRequest:
    """Valida el mensaje y mantiene el código separado de los argumentos confiables."""
    if language not in LANGUAGES:
        raise ValueError("Lenguaje no soportado")
    if not isinstance(source_code, str):
        raise ValueError("source_code debe ser texto UTF-8")
    source = source_code.encode("utf-8")
    if len(source) > SOURCE_CODE_MAX_BYTES:
        raise ValueError("El código excede el límite permitido")
    runtime = runtime_for(language)
    return CompilationRequest(
        language=language,
        source_name=runtime.source_name,
        source=source,
        compile_argv=runtime.compile_argv,
        run_argv=runtime.run_argv,
        timeout_ms=compile_timeout_ms(language),
    )


def prepare_submission(
    backend: CompilationBackend, language: Language, source_code: str
) -> CompilationResult:
    """Prepara una sola vez el artefacto y separa CE de fallos internos SE."""
    request = compilation_request(language, source_code)
    observation = backend.prepare(request)
    compile_output = _compile_output(observation)

    if observation.system_error:
        return CompilationResult(
            None,
            request.run_argv,
            Verdict.SE,
            compile_output,
            "El backend de compilación informó un fallo interno",
        )

    failed = observation.timed_out or observation.output_exceeded or observation.exit_code != 0
    if failed:
        # Python no compila: cualquier fallo durante su empaquetado es de infraestructura.
        verdict = Verdict.CE if request.compile_argv is not None else Verdict.SE
        error = None if verdict == Verdict.CE else "No se pudo preparar el artefacto interpretado"
        return CompilationResult(None, request.run_argv, verdict, compile_output, error)

    if observation.artifact_reference is None:
        return CompilationResult(
            None,
            request.run_argv,
            Verdict.SE,
            compile_output,
            "El backend terminó sin entregar un artefacto",
        )

    return CompilationResult(
        CompiledArtifact(observation.artifact_reference), request.run_argv, None, compile_output
    )


def _compile_output(observation: CompilationObservation) -> str:
    """Sanea y acota el diagnóstico que puede mostrarse al dueño del envío."""
    combined = observation.stderr or observation.stdout
    return combined[:MAX_COMPILE_OUTPUT_BYTES].decode("utf-8", errors="replace")
