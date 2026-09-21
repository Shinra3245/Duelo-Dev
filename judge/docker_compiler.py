"""Backend Docker rootless para compilar y empaquetar artefactos del juez.

La compilación ocurre en un contenedor limitado y sin red. El empaquetado copia únicamente
archivos regulares, validados y de solo lectura a un contenedor detenido de la imagen base;
Docker lo confirma como imagen sin ejecutar el código del jugador.
"""

from io import BytesIO
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import tempfile
from typing import Mapping
from uuid import uuid4

from judge.compiler import CompilationBackend, CompilationObservation, CompilationRequest
from judge.limits import BOX_TMPFS_MB, CPU_LIMIT, MEMORY_LIMIT_MB, PIDS_LIMIT, Language
from judge.runtime import DockerInvoker, RuntimeObservation
from judge.sandbox import RUNNER_GID, RUNNER_UID, container_id_from_reference


ARTIFACT_BUILD_TIMEOUT_MS = 30_000
MAX_ARTIFACT_BYTES = BOX_TMPFS_MB * 1024 * 1024
MAX_ARTIFACT_FILES = 4096
DOCKER_INFRASTRUCTURE_EXIT_CODES = frozenset((125, 126, 127))
_PINNED_IMAGE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[0-9a-f]{64}$")
_LOCAL_IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
_CONTAINER_ID = re.compile(r"^[0-9a-f]{64}$")
_TOKEN = re.compile(r"^[0-9a-f]{32}$")
_ARTIFACT_TAG = re.compile(r"^duelodev-artifact-[0-9a-f]{32}$")
_RESOURCE_OWNER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_KEEPALIVE = "while :; do sleep 3600; done"


class DockerCompilationBackend(CompilationBackend):
    """Compila y empaqueta una fuente sin interpolarla en comandos."""

    def __init__(
        self,
        invoker: DockerInvoker,
        base_images: Mapping[Language, str],
        resource_owner: str | None = None,
    ) -> None:
        missing = {
            language for language in ("python", "cpp", "java") if language not in base_images
        }
        if missing:
            raise ValueError(f"Faltan imágenes base para: {', '.join(sorted(missing))}")
        invalid = [image for image in base_images.values() if not _PINNED_IMAGE.fullmatch(image)]
        if invalid:
            raise ValueError("Todas las imágenes base deben estar fijadas por digest de registro")
        if resource_owner is not None and not _RESOURCE_OWNER.fullmatch(resource_owner):
            raise ValueError("resource_owner tiene un formato inválido")
        self._invoker = invoker
        self._base_images = dict(base_images)
        self._resource_owner = resource_owner

    def prepare(self, request: CompilationRequest) -> CompilationObservation:
        base_image = self._base_images[request.language]
        artifact_tag = f"duelodev-artifact-{uuid4().hex}"
        staging_token = uuid4().hex
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

            try:
                archive = _artifact_archive(
                    app_dir,
                    out_dir,
                    executable_output="main" if request.language == "cpp" else None,
                )
            except (OSError, ValueError, tarfile.TarError):
                return CompilationObservation(
                    None,
                    compile_observation.stdout,
                    compile_observation.stderr,
                    compile_observation.exit_code,
                    system_error=True,
                )

            created = self._invoker.invoke(
                artifact_staging_create_argv(
                    base_image,
                    staging_token,
                    self._resource_owner,
                    direct_session=request.language == "python",
                ),
                b"",
                ARTIFACT_BUILD_TIMEOUT_MS,
            )
            staging_id = created.stdout.decode("ascii", errors="ignore").strip()
            if not _successful(created) or not _CONTAINER_ID.fullmatch(staging_id):
                self._remove_staging_by_label(staging_token)
                if request.language != "python":
                    self._remove_image(artifact_tag)
                return _packaging_failure(created)

            if request.language == "python":
                started = self._invoker.invoke(
                    artifact_staging_start_argv(staging_id), b"", ARTIFACT_BUILD_TIMEOUT_MS
                )
                if not _successful(started):
                    self._remove_staging(staging_id, staging_token)
                    return _packaging_failure(started)
                copy_argv = artifact_copy_to_running_session_argv(staging_id)
            else:
                copy_argv = artifact_copy_argv(staging_id)
            copied = self._invoker.invoke(copy_argv, archive, ARTIFACT_BUILD_TIMEOUT_MS)
            if not _successful(copied):
                self._remove_staging(staging_id, staging_token)
                if request.language != "python":
                    self._remove_image(artifact_tag)
                return _packaging_failure(copied)

            if request.language == "python":
                return CompilationObservation(
                    f"container:{staging_id}",
                    compile_observation.stdout,
                    compile_observation.stderr,
                    compile_observation.exit_code,
                )

            committed = self._invoker.invoke(
                artifact_commit_argv(staging_id, artifact_tag, self._resource_owner),
                b"",
                ARTIFACT_BUILD_TIMEOUT_MS,
            )
            artifact_reference = committed.stdout.decode("ascii", errors="ignore").strip()
            if not _successful(committed) or not _LOCAL_IMAGE_ID.fullmatch(artifact_reference):
                self._remove_staging(staging_id, staging_token)
                self._remove_image(artifact_tag)
                return _packaging_failure(committed)

            if not self._remove_staging(staging_id, staging_token):
                self._remove_image(artifact_reference)
                self._remove_image(artifact_tag)
                return CompilationObservation(
                    None,
                    committed.stdout,
                    committed.stderr,
                    committed.exit_code,
                    system_error=True,
                )

            return CompilationObservation(
                artifact_reference,
                compile_observation.stdout,
                compile_observation.stderr,
                compile_observation.exit_code,
            )

    def cleanup(self, artifact_reference: str) -> bool:
        """Elimina la imagen o contenedor efímero al terminar el juicio."""
        if not _LOCAL_IMAGE_ID.fullmatch(artifact_reference):
            container_id = container_id_from_reference(artifact_reference)
            if container_id is None:
                raise ValueError("La referencia de limpieza debe ser un digest local")
            removed = self._invoker.invoke(
                ("docker", "rm", "--force", container_id), b"", ARTIFACT_BUILD_TIMEOUT_MS
            )
            if _successful(removed):
                return True
            listed = self._invoker.invoke(
                (
                    "docker",
                    "ps",
                    "--all",
                    "--quiet",
                    "--no-trunc",
                    "--filter",
                    f"id={container_id}",
                ),
                b"",
                ARTIFACT_BUILD_TIMEOUT_MS,
            )
            return _successful(listed) and not listed.stdout.strip()
        return self._remove_image(artifact_reference)

    def _remove_image(self, reference: str) -> bool:
        if not (_LOCAL_IMAGE_ID.fullmatch(reference) or _ARTIFACT_TAG.fullmatch(reference)):
            raise ValueError("Referencia de imagen temporal inválida")
        observation = self._invoker.invoke(
            ("docker", "image", "rm", "--force", reference), b"", ARTIFACT_BUILD_TIMEOUT_MS
        )
        return _successful(observation)

    def _remove_staging(self, container_id: str, token: str) -> bool:
        if not _CONTAINER_ID.fullmatch(container_id) or not _TOKEN.fullmatch(token):
            return False
        removed = self._invoker.invoke(
            ("docker", "rm", "--force", container_id), b"", ARTIFACT_BUILD_TIMEOUT_MS
        )
        return _successful(removed) or self._remove_staging_by_label(token)

    def _remove_staging_by_label(self, token: str) -> bool:
        if not _TOKEN.fullmatch(token):
            return False
        listed = self._invoker.invoke(
            (
                "docker",
                "ps",
                "--all",
                "--quiet",
                "--filter",
                f"label=duelodev.judge.artifact-staging={token}",
            ),
            b"",
            ARTIFACT_BUILD_TIMEOUT_MS,
        )
        if not _successful(listed):
            return False
        identifiers = listed.stdout.decode("ascii", errors="ignore").split()
        if any(not re.fullmatch(r"[0-9a-f]{12,64}", value) for value in identifiers):
            return False
        if not identifiers:
            return True
        removed = self._invoker.invoke(
            ("docker", "rm", "--force", *identifiers), b"", ARTIFACT_BUILD_TIMEOUT_MS
        )
        return _successful(removed)


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


def artifact_staging_create_argv(
    base_image: str,
    token: str,
    resource_owner: str | None = None,
    *,
    direct_session: bool = False,
) -> tuple[str, ...]:
    if not _PINNED_IMAGE.fullmatch(base_image):
        raise ValueError("La imagen base debe estar fijada por digest")
    if not _TOKEN.fullmatch(token):
        raise ValueError("El token de staging es inválido")
    if resource_owner is not None and not _RESOURCE_OWNER.fullmatch(resource_owner):
        raise ValueError("resource_owner tiene un formato inválido")
    if direct_session:
        return (
            "docker",
            "create",
            "--init",
            "--label",
            f"duelodev.judge.artifact-staging={token}",
            "--label",
            f"duelodev.judge.session={token}",
            *(("--label", f"duelodev.judge.worker={resource_owner}") if resource_owner else ()),
            "--network",
            "none",
            "--read-only",
            "--tmpfs",
            f"/app:rw,nosuid,nodev,size={BOX_TMPFS_MB}m,mode=755",
            "--tmpfs",
            f"/out:rw,nosuid,nodev,size={BOX_TMPFS_MB}m,mode=755",
            "--tmpfs",
            f"/tmp:rw,noexec,nosuid,size={BOX_TMPFS_MB}m,mode=1777",
            "--user",
            "0:0",
            "--cap-drop",
            "ALL",
            "--cap-add",
            "DAC_OVERRIDE",
            "--cap-add",
            "FOWNER",
            "--cap-add",
            "KILL",
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
            base_image,
            "/bin/sh",
            "-c",
            _KEEPALIVE,
        )
    return (
        "docker",
        "create",
        "--network",
        "none",
        "--label",
        f"duelodev.judge.artifact-staging={token}",
        *(("--label", f"duelodev.judge.worker={resource_owner}") if resource_owner else ()),
        base_image,
    )


def artifact_staging_start_argv(container_id: str) -> tuple[str, ...]:
    if not _CONTAINER_ID.fullmatch(container_id):
        raise ValueError("El identificador de staging es inválido")
    return "docker", "start", container_id


def artifact_copy_to_running_session_argv(container_id: str) -> tuple[str, ...]:
    if not _CONTAINER_ID.fullmatch(container_id):
        raise ValueError("El identificador de staging es inválido")
    return (
        "docker",
        "exec",
        "--interactive",
        "--user",
        "0:0",
        container_id,
        "tar",
        "--extract",
        "--file",
        "-",
        "--directory",
        "/",
        "--no-same-owner",
        "--no-same-permissions",
    )


def artifact_copy_argv(container_id: str) -> tuple[str, ...]:
    if not _CONTAINER_ID.fullmatch(container_id):
        raise ValueError("El identificador de staging es inválido")
    return "docker", "cp", "--archive", "-", f"{container_id}:/"


def artifact_commit_argv(
    container_id: str, artifact_tag: str, resource_owner: str | None = None
) -> tuple[str, ...]:
    if not _CONTAINER_ID.fullmatch(container_id):
        raise ValueError("El identificador de staging es inválido")
    if not _ARTIFACT_TAG.fullmatch(artifact_tag):
        raise ValueError("La etiqueta temporal es inválida")
    if resource_owner is not None and not _RESOURCE_OWNER.fullmatch(resource_owner):
        raise ValueError("resource_owner tiene un formato inválido")
    return (
        "docker",
        "commit",
        "--change",
        "WORKDIR /app",
        "--change",
        f"USER {RUNNER_UID}:{RUNNER_GID}",
        *(("--change", f"LABEL duelodev.judge.worker={resource_owner}") if resource_owner else ()),
        container_id,
        artifact_tag,
    )


def _artifact_archive(app_dir: Path, out_dir: Path, executable_output: str | None = None) -> bytes:
    """Empaqueta datos acotados: sin symlinks, hardlinks, traversal ni permisos de escritura."""
    buffer = BytesIO()
    file_count = 0
    total_file_bytes = 0

    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for root_name, root in (("app", app_dir), ("out", out_dir)):
            _add_directory(archive, root_name)
            paths = sorted(root.rglob("*"), key=lambda path: path.as_posix())
            for path in paths:
                relative = PurePosixPath(path.relative_to(root).as_posix())
                if relative.is_absolute() or any(
                    part in {"", ".", ".."} for part in relative.parts
                ):
                    raise ValueError("La ruta del artefacto es inválida")
                metadata = path.lstat()
                archive_name = f"{root_name}/{relative.as_posix()}"

                if stat.S_ISDIR(metadata.st_mode):
                    _add_directory(archive, archive_name)
                    continue
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                    raise ValueError("El artefacto contiene un archivo no regular")
                if metadata.st_size < 0 or metadata.st_size > MAX_ARTIFACT_BYTES:
                    raise ValueError("El artefacto excede el límite permitido")
                total_file_bytes += metadata.st_size
                file_count += 1
                if total_file_bytes > MAX_ARTIFACT_BYTES or file_count > MAX_ARTIFACT_FILES:
                    raise ValueError("El artefacto excede el límite permitido")

                contents = path.read_bytes()
                if len(contents) != metadata.st_size:
                    raise ValueError("El artefacto cambió durante su lectura")
                item = tarfile.TarInfo(archive_name)
                item.size = len(contents)
                item.mode = (
                    0o555
                    if root_name == "out" and relative.as_posix() == executable_output
                    else 0o444
                )
                item.uid = RUNNER_UID
                item.gid = RUNNER_GID
                item.mtime = 0
                archive.addfile(item, BytesIO(contents))

    archive_bytes = buffer.getvalue()
    if len(archive_bytes) > MAX_ARTIFACT_BYTES:
        raise ValueError("El artefacto excede el límite permitido")
    return archive_bytes


def _add_directory(archive: tarfile.TarFile, name: str) -> None:
    item = tarfile.TarInfo(name)
    item.type = tarfile.DIRTYPE
    item.mode = 0o555
    item.uid = RUNNER_UID
    item.gid = RUNNER_GID
    item.mtime = 0
    archive.addfile(item)


def _packaging_failure(observation: RuntimeObservation) -> CompilationObservation:
    return CompilationObservation(
        None,
        observation.stdout,
        observation.stderr,
        observation.exit_code,
        observation.timed_out,
        observation.output_exceeded,
        system_error=True,
    )


def _compile_failed(observation: RuntimeObservation) -> bool:
    return (
        observation.system_error
        or observation.timed_out
        or observation.output_exceeded
        or observation.exit_code != 0
    )


def _successful(observation: RuntimeObservation) -> bool:
    return (
        not observation.system_error
        and not observation.timed_out
        and not observation.output_exceeded
        and observation.exit_code == 0
    )
