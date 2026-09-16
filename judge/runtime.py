"""Adaptador de runtime para el daemon Docker rootless del juez.

No usa shell ni recibe respuestas esperadas. La ejecución real se inyecta para
que la construcción de la invocación pueda probarse sin iniciar contenedores.
"""

from dataclasses import dataclass
from math import ceil
import os
import re
import subprocess
import tempfile
import threading
from time import monotonic, sleep
from typing import IO, Protocol
from uuid import uuid4

from judge.capture import BoundedCapture
from judge.evaluation import CaseExecution
from judge.limits import BOX_TMPFS_MB, CPU_LIMIT, OUTPUT_LIMIT_BYTES, WALL_CLOCK_MARGIN
from judge.sandbox import RUNNER_GID, RUNNER_UID, SandboxSpec
from judge.supervisor import CompiledArtifact


_RESOURCE_OWNER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


@dataclass(frozen=True)
class RuntimeObservation:
    stdout: bytes
    stderr: bytes
    exit_code: int
    time_ms: int
    timed_out: bool = False
    oom_killed: bool = False
    output_exceeded: bool = False
    system_error: bool = False


class DockerInvoker(Protocol):
    """Implementación concreta que transmite stdin y limita salida fuera del jugador."""

    def invoke(
        self, argv: tuple[str, ...], stdin: bytes, timeout_ms: int
    ) -> RuntimeObservation: ...


class SubprocessDockerInvoker:
    """Ejecuta argv sin shell y drena stdout/stderr con un límite estricto."""

    def __init__(
        self,
        output_limit_bytes: int = OUTPUT_LIMIT_BYTES,
        resource_owner: str | None = None,
    ) -> None:
        if type(output_limit_bytes) is not int or output_limit_bytes < 1:
            raise ValueError("output_limit_bytes debe ser positivo")
        if resource_owner is not None and not _RESOURCE_OWNER.fullmatch(resource_owner):
            raise ValueError("resource_owner tiene un formato inválido")
        self._output_limit_bytes = output_limit_bytes
        self._resource_owner = resource_owner

    def invoke(self, argv: tuple[str, ...], stdin: bytes, timeout_ms: int) -> RuntimeObservation:
        if not argv or type(timeout_ms) is not int or timeout_ms < 1:
            raise ValueError("argv y timeout_ms deben ser válidos")
        if not isinstance(stdin, bytes):
            raise ValueError("stdin debe ser bytes")

        started = monotonic()
        cidfile: str | None = None
        run_token: str | None = None
        runtime_argv = argv
        if len(argv) >= 2 and argv[0] == "docker" and argv[1] == "run":
            fd, cidfile = tempfile.mkstemp(prefix="duelodev-judge-", suffix=".cid")
            os.close(fd)
            os.unlink(cidfile)
            run_token = uuid4().hex
            runtime_argv = tracked_run_argv(argv, cidfile, run_token, self._resource_owner)
        try:
            process = subprocess.Popen(
                runtime_argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
            )
        except OSError:
            if cidfile is not None:
                self._remove_container(argv[0], cidfile, run_token)
            return RuntimeObservation(b"", b"", -1, 0, system_error=True)
        try:
            assert process.stdin is not None
            assert process.stdout is not None
            assert process.stderr is not None
            stdout = BoundedCapture(self._output_limit_bytes)
            stderr = BoundedCapture(self._output_limit_bytes)
            overflow = threading.Event()
            threads = [
                self._start_reader(process.stdout, stdout, overflow),
                self._start_reader(process.stderr, stderr, overflow),
                self._start_writer(process.stdin, stdin),
            ]

            deadline = started + timeout_ms / 1000
            timed_out = False
            while process.poll() is None:
                if overflow.wait(timeout=0.01):
                    process.kill()
                    break
                if monotonic() >= deadline:
                    timed_out = True
                    process.kill()
                    break

            process.wait()
            for thread in threads:
                thread.join(timeout=1)
            elapsed_ms = round((monotonic() - started) * 1000)
            oom_killed = (
                self._container_oom_killed(argv[0], cidfile)
                if cidfile is not None and process.returncode == 137
                else False
            )
            return RuntimeObservation(
                stdout.data,
                stderr.data,
                process.returncode,
                elapsed_ms,
                timed_out=timed_out,
                oom_killed=oom_killed,
                output_exceeded=overflow.is_set(),
                system_error=process.returncode == 125 and not timed_out and not overflow.is_set(),
            )
        finally:
            if cidfile is not None:
                self._remove_container(argv[0], cidfile, run_token)

    @staticmethod
    def _remove_container(docker: str, cidfile: str, run_token: str | None) -> None:
        container_id = SubprocessDockerInvoker._read_container_id(cidfile)
        try:
            removed = False
            if container_id:
                removal = subprocess.run(
                    (docker, "rm", "-f", container_id),
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                )
                removed = removal.returncode == 0
            if run_token and not removed:
                sleep(0.2)
                leftovers = subprocess.check_output(
                    (docker, "ps", "-aq", "--filter", f"label=duelodev.judge.run={run_token}"),
                    text=True,
                    timeout=10,
                ).split()
                if leftovers:
                    subprocess.run(
                        (docker, "rm", "-f", *leftovers),
                        check=False,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=10,
                    )
        except (OSError, subprocess.SubprocessError):
            pass
        finally:
            try:
                os.unlink(cidfile)
            except FileNotFoundError:
                pass

    @staticmethod
    def _container_oom_killed(docker: str, cidfile: str) -> bool:
        container_id = SubprocessDockerInvoker._read_container_id(cidfile)
        if not container_id:
            return False
        try:
            value = subprocess.check_output(
                (docker, "inspect", "--format", "{{.State.OOMKilled}}", container_id),
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=10,
            ).strip()
            return value == "true"
        except (OSError, subprocess.SubprocessError):
            return False

    @staticmethod
    def _read_container_id(cidfile: str) -> str:
        try:
            with open(cidfile, encoding="utf-8") as file:
                return file.read().strip()
        except OSError:
            return ""

    @staticmethod
    def _start_reader(
        stream: IO[bytes], capture: BoundedCapture, overflow: threading.Event
    ) -> threading.Thread:
        def read() -> None:
            while chunk := stream.read(64 * 1024):
                capture.append(chunk)
                if capture.exceeded:
                    overflow.set()

        thread = threading.Thread(target=read, daemon=True, name="judge-io-reader")
        thread.start()
        return thread

    @staticmethod
    def _start_writer(stream: IO[bytes], stdin: bytes) -> threading.Thread:
        def write() -> None:
            try:
                stream.write(stdin)
                stream.close()
            except BrokenPipeError:
                pass

        thread = threading.Thread(target=write, daemon=True, name="judge-io-writer")
        thread.start()
        return thread


def docker_run_argv(spec: SandboxSpec) -> tuple[str, ...]:
    """Construye argv fijo: no hay interpolación de shell, red ni volúmenes."""
    return (
        "docker",
        "run",
        "--interactive",
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        f"/tmp:rw,noexec,nosuid,size={BOX_TMPFS_MB}m,mode=1777",
        "--user",
        f"{RUNNER_UID}:{RUNNER_GID}",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        f"{spec.memory_limit_mb}m",
        "--memory-swap",
        f"{spec.memory_limit_mb}m",
        "--cpus",
        str(CPU_LIMIT),
        "--pids-limit",
        str(spec.pids_limit),
        spec.image,
        *spec.command,
    )


class DockerCaseRunner:
    """Entrega stdin al runtime y convierte su observación en datos confiables."""

    def __init__(self, invoker: DockerInvoker) -> None:
        self._invoker = invoker

    def run_case(
        self, artifact: CompiledArtifact, sandbox: SandboxSpec, stdin: bytes, ordinal: int
    ) -> CaseExecution:
        if artifact.reference != sandbox.image:
            raise ValueError("El artefacto debe coincidir con la imagen fijada del sandbox")
        observation = self._invoker.invoke(
            docker_run_argv(sandbox), stdin, ceil(sandbox.time_limit_ms * WALL_CLOCK_MARGIN)
        )
        return CaseExecution(
            ordinal=ordinal,
            stdout=observation.stdout,
            stderr=observation.stderr,
            exit_code=observation.exit_code,
            time_ms=observation.time_ms,
            timed_out=observation.timed_out,
            oom_killed=observation.oom_killed,
            output_exceeded=observation.output_exceeded,
            system_error=observation.system_error,
        )


def tracked_run_argv(
    argv: tuple[str, ...],
    cidfile: str,
    run_token: str,
    resource_owner: str | None,
) -> tuple[str, ...]:
    if len(argv) < 2 or argv[:2] != ("docker", "run"):
        raise ValueError("Sólo se puede etiquetar una invocación docker run")
    if not cidfile or not re.fullmatch(r"[0-9a-f]{32}", run_token):
        raise ValueError("El tracking de la ejecución es inválido")
    if resource_owner is not None and not _RESOURCE_OWNER.fullmatch(resource_owner):
        raise ValueError("resource_owner tiene un formato inválido")
    return (
        argv[:2]
        + ("--cidfile", cidfile, "--label", f"duelodev.judge.run={run_token}")
        + (
            ("--label", f"duelodev.judge.worker={resource_owner}")
            if resource_owner is not None
            else ()
        )
        + argv[2:]
    )
