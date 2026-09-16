"""Backend de compilación para el daemon Docker rootless del juez.

La compilación ocurre en un contenedor limitado y con red deshabilitada. Después se crea una
imagen por envío mediante un Dockerfile fijo que solo copia la fuente y el artefacto; esa fase
no ejecuta contenido del jugador.
"""

from pathlib import Path
import re
import tempfile
from typing import Mapping
from uuid import uuid4

from judge.compiler import CompilationBackend, CompilationObservation, CompilationRequest
from judge.limits import BOX_TMPFS_MB, CPU_LIMIT, MEMORY_LIMIT_MB, PIDS_LIMIT, Language
from judge.runtime import DockerInvoker, RuntimeObservation
from judge.sandbox import RUNNER_GID, RUNNER_UID


ARTIFACT_BUILD_TIMEOUT_MS = 30_000
DOCKER_INFRASTRUCTURE_EXIT_CODES = frozenset((125, 126, 127))
_PINNED_IMAGE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[0-9a-f]{64}$")
_LOCAL_IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
_ARTIFACT_TAG = re.compile(r"^duelodev-artifact-[0-9a-f]{32}$")


class DockerCompilationBackend(CompilationBackend):
    """Compila y empaqueta una fuente sin ejecutar comandos mediante shell."""

    def __init__(self, invoker: DockerInvoker, base_images: Mapping[Language, str]) -> None:
        missing = {
            language for language in ("python", "cpp", "java") if language not in base_images
        }
        if missing:
            raise ValueError(f"Faltan imágenes base para: {', '.join(sorted(missing))}")
        invalid = [image for image in base_images.values() if not _PINNED_IMAGE.fullmatch(image)]
        if invalid:
            raise ValueError("Todas las imágenes base deben estar fijadas por digest de registro")
        self._invoker = invoker
        self._base_images = dict(base_images)

    def prepare(self, request: CompilationRequest) -> CompilationObservation:
        base_image = self._base_images[request.language]
        artifact_tag = f"duelodev-artifact-{uuid4().hex}"
        with tempfile.TemporaryDirectory(prefix="duelodev-compile-") as directory:
            context = Path(directory)
            app_dir = context / "app"
            out_dir = context / "out"
            app_dir.mkdir(mode=0o700)
            out_dir.mkdir(mode=0o700)
            source_path = app_dir / request.source_name
            source_path.write_bytes(request.source)
            source_path.chmod(0o600)

            compile_observation = RuntimeObservation(b"", b"", 0, 0)
            if request.compile_argv is not None:
                compile_observation = self._invoker.invoke(
                    compile_container_argv(request, base_image, app_dir, out_dir),
                    b"",
                    request.timeout_ms,
                )
                if _compile_failed(compile_observation):
                    return CompilationObservation(
                        None,
                        compile_observation.stdout,
                        compile_observation.stderr,
                        compile_observation.exit_code,
                        compile_observation.timed_out,
                        compile_observation.output_exceeded,
                        compile_observation.system_error
                        or compile_observation.exit_code in DOCKER_INFRASTRUCTURE_EXIT_CODES,
                    )

            dockerfile = context / "Dockerfile"
            dockerfile.write_text(artifact_dockerfile(base_image), encoding="utf-8")
            dockerfile.chmod(0o600)
            build = self._invoker.invoke(
                docker_build_argv(context, artifact_tag), b"", ARTIFACT_BUILD_TIMEOUT_MS
            )
            artifact_reference = build.stdout.decode("ascii", errors="ignore").strip()
            if (
                build.system_error
                or build.timed_out
                or build.output_exceeded
                or build.exit_code != 0
                or not _LOCAL_IMAGE_ID.fullmatch(artifact_reference)
            ):
                self._remove_image(artifact_tag)
                return CompilationObservation(
                    None,
                    build.stdout,
                    build.stderr,
                    build.exit_code,
                    build.timed_out,
                    build.output_exceeded,
                    system_error=True,
                )

            return CompilationObservation(
                artifact_reference,
                compile_observation.stdout,
                compile_observation.stderr,
                compile_observation.exit_code,
            )

    def cleanup(self, artifact_reference: str) -> bool:
        """Elimina la imagen efímera al terminar el juicio."""
        if not _LOCAL_IMAGE_ID.fullmatch(artifact_reference):
            raise ValueError("La referencia de limpieza debe ser un digest local")
        return self._remove_image(artifact_reference)

    def _remove_image(self, reference: str) -> bool:
        if not (_LOCAL_IMAGE_ID.fullmatch(reference) or _ARTIFACT_TAG.fullmatch(reference)):
            raise ValueError("Referencia de imagen temporal inválida")
        observation = self._invoker.invoke(
            ("docker", "image", "rm", "--force", reference), b"", ARTIFACT_BUILD_TIMEOUT_MS
        )
        return not observation.system_error and observation.exit_code == 0


def compile_container_argv(
    request: CompilationRequest, base_image: str, app_dir: Path, out_dir: Path
) -> tuple[str, ...]:
    """Construye una invocación cerrada con montajes limitados al contexto privado."""
    if request.compile_argv is None:
        raise ValueError("El lenguaje solicitado no requiere compilación")
    if not _PINNED_IMAGE.fullmatch(base_image):
        raise ValueError("La imagen del compilador debe estar fijada por digest")
    app_path = str(app_dir.resolve())
    out_path = str(out_dir.resolve())
    return (
        "docker",
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        f"/tmp:rw,nosuid,size={BOX_TMPFS_MB}m,mode=1777",
        "--user",
        "0:0",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        f"{MEMORY_LIMIT_MB}m",
        "--memory-swap",
        f"{MEMORY_LIMIT_MB}m",
        "--cpus",
        str(CPU_LIMIT),
        "--pids-limit",
        str(PIDS_LIMIT),
        "--mount",
        f"type=bind,src={app_path},dst=/app,readonly",
        "--mount",
        f"type=bind,src={out_path},dst=/out",
        "--workdir",
        "/app",
        base_image,
        *request.compile_argv,
    )


def docker_build_argv(context: Path, artifact_tag: str) -> tuple[str, ...]:
    if not _ARTIFACT_TAG.fullmatch(artifact_tag):
        raise ValueError("Etiqueta temporal inválida")
    return (
        "docker",
        "build",
        "--network",
        "none",
        "--pull=false",
        "--no-cache",
        "--quiet",
        "--tag",
        artifact_tag,
        str(context.resolve()),
    )


def artifact_dockerfile(base_image: str) -> str:
    """Dockerfile fijo: copia datos; no contiene RUN, ARG ni interpolación de fuente."""
    if not _PINNED_IMAGE.fullmatch(base_image):
        raise ValueError("La imagen base debe estar fijada por digest")
    return (
        f"FROM {base_image}\n"
        f"COPY --chown={RUNNER_UID}:{RUNNER_GID} app/ /app/\n"
        f"COPY --chown={RUNNER_UID}:{RUNNER_GID} out/ /out/\n"
        "WORKDIR /app\n"
        f"USER {RUNNER_UID}:{RUNNER_GID}\n"
    )


def _compile_failed(observation: RuntimeObservation) -> bool:
    return (
        observation.system_error
        or observation.timed_out
        or observation.output_exceeded
        or observation.exit_code != 0
    )
