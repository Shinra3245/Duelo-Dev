"""Backend Docker rootless para una sesión aislada por envío."""

from dataclasses import dataclass
import base64
import binascii
import json
import re
import threading
from collections.abc import Sequence
from typing import Callable
from uuid import uuid4

from judge.limits import BOX_TMPFS_MB, CPU_LIMIT, OUTPUT_LIMIT_BYTES
from judge.evaluation import CaseExecution
from judge.runtime import DockerInvoker, RuntimeObservation, SubprocessDockerInvoker
from judge.sandbox import RUNNER_GID, RUNNER_UID, SandboxSpec, container_id_from_reference
from judge.supervisor import CaseInput


CONTROL_TIMEOUT_MS = 10_000
RESET_TIMEOUT_MS = 3_000
_CONTAINER_ID = re.compile(r"^[0-9a-f]{64}$")
_TOKEN = re.compile(r"^[0-9a-f]{32}$")
_RESOURCE_OWNER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_KEEPALIVE = "while :; do sleep 3600; done"
_BATCH_CONTROLLER = r"""import base64,binascii,json,os,selectors,shutil,signal,subprocess,sys,time
MAX_OUTPUT=1048576
command=tuple(sys.argv[3:])

def oom_count():
    try:
        with open('/sys/fs/cgroup/memory.events', encoding='ascii') as file:
            for line in file:
                key,value=line.split()[:2]
                if key == 'oom_kill':
                    return int(value)
    except (OSError,ValueError):
        return None
    return None

def kill_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError,PermissionError):
        try:
            process.kill()
        except ProcessLookupError:
            pass

def clean_processes():
    for _ in range(20):
        found=False
        for entry in os.listdir('/proc'):
            if not entry.isdigit() or int(entry) == os.getpid():
                continue
            try:
                status=open('/proc/'+entry+'/status', encoding='ascii').read()
                uid_line=next(line for line in status.splitlines() if line.startswith('Uid:'))
                if int(uid_line.split()[1]) == os.getuid():
                    os.kill(int(entry), signal.SIGKILL)
                    found=True
            except (OSError,StopIteration,ValueError):
                pass
        if not found:
            return True
        time.sleep(0.01)
    return False

def clean_tmp():
    clean=True
    try:
        for name in os.listdir('/tmp'):
            path=os.path.join('/tmp',name)
            try:
                if os.path.isdir(path) and not os.path.islink(path):
                    os.chmod(path, 0o700)
                    shutil.rmtree(path)
                else:
                    os.unlink(path)
            except OSError:
                clean=False
    except OSError:
        return False
    return clean

def run_case(encoded, timeout_ms):
    before=oom_count()
    try:
        stdin=base64.b64decode(encoded, validate=True)
    except (ValueError,binascii.Error):
        return {'exit_code':-1,'stderr':'','stdout':'','time_ms':0,'timed_out':False,'oom_killed':False,'output_exceeded':False,'clean':False}
    started=time.monotonic()
    process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    def feed():
        try:
            process.stdin.write(stdin)
            process.stdin.close()
        except (BrokenPipeError,OSError):
            pass
    threading=__import__('threading')
    writer=threading.Thread(target=feed,daemon=True)
    writer.start()
    selector=selectors.DefaultSelector()
    selector.register(process.stdout,selectors.EVENT_READ,'stdout')
    selector.register(process.stderr,selectors.EVENT_READ,'stderr')
    outputs={'stdout':bytearray(),'stderr':bytearray()}
    exceeded=False
    timed_out=False
    deadline=started+timeout_ms/1000
    while selector.get_map() or process.poll() is None:
        remaining=max(0,min(0.05,deadline-time.monotonic()))
        if time.monotonic() >= deadline and process.poll() is None:
            timed_out=True
            kill_group(process)
        for key,_ in selector.select(remaining):
            try:
                chunk=os.read(key.fileobj.fileno(),65536)
            except OSError:
                chunk=b''
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            target=outputs[key.data]
            if len(target) < MAX_OUTPUT+1:
                target.extend(chunk[:MAX_OUTPUT+1-len(target)])
            if len(target) > MAX_OUTPUT:
                exceeded=True
                kill_group(process)
    returncode=process.wait()
    writer.join(timeout=1)
    clean=clean_processes() and clean_tmp()
    after=oom_count()
    return {'exit_code':returncode,'stderr':base64.b64encode(bytes(outputs['stderr'])).decode(),'stdout':base64.b64encode(bytes(outputs['stdout'])).decode(),'time_ms':round((time.monotonic()-started)*1000),'timed_out':timed_out,'oom_killed':before is not None and after is not None and after > before,'output_exceeded':exceeded,'clean':clean}

timeout_ms=int(sys.argv[2])
for line in sys.stdin:
    result=run_case(line.strip(),timeout_ms)
    print(json.dumps(result,separators=(',',':')),flush=True)
    if not result['clean']:
        break
"""
_EXECUTE_AND_RESET = (
    'exec 3<&0; "$@" <&3 3<&- & child=$!; wait "$child"; result=$?; '
    "attempt=0; sleeper=; "
    'while [ "$attempt" -lt 20 ]; do '
    "found=0; "
    "for status in /proc/[0-9]*/status; do "
    '[ -r "$status" ] || continue; uid=; '
    "while read key value rest; do "
    '[ "$key" = "Uid:" ] && { uid=$value; break; }; '
    'done < "$status"; '
    f'[ "$uid" = "{RUNNER_UID}" ] && '
    '[ "${status#/proc/}" != "$$/status" ] && '
    '[ "${status#/proc/}" != "${sleeper}/status" ] && '
    '{ pid=${status#/proc/}; pid=${pid%/status}; kill -KILL "$pid" 2>/dev/null || true; found=1; }; '
    "done; "
    '[ "$found" -eq 0 ] && break; '
    "attempt=$((attempt + 1)); sleep 0.01 & sleeper=$!; done; "
    '[ -n "$sleeper" ] && wait "$sleeper" 2>/dev/null || true; '
    "clean=1; "
    "for status in /proc/[0-9]*/status; do "
    '[ -r "$status" ] || continue; uid=; '
    "while read key value rest; do "
    '[ "$key" = "Uid:" ] && { uid=$value; break; }; '
    'done < "$status"; '
    f'[ "$uid" = "{RUNNER_UID}" ] && '
    '[ "${status#/proc/}" != "$$/status" ] && clean=0; '
    "done; "
    "rm -rf /tmp/..?* /tmp/.[!.]* /tmp/* 2>/dev/null || clean=0; "
    'if [ "$clean" -eq 1 ]; then '
    'case "$result" in 0) exit 255;; 137) exit 253;; *) exit 254;; esac; '
    'else case "$result" in 0) exit 252;; 137) exit 250;; *) exit 251;; esac; fi'
)
_OOM_COUNT = (
    "while read key value; do "
    '[ "$key" = "oom_kill" ] && { printf "%s\\n" "$value"; exit 0; }; '
    "done < /sys/fs/cgroup/memory.events; exit 1"
)
_RESET = (
    "attempt=0; "
    'while [ "$attempt" -lt 20 ]; do '
    "found=0; "
    "for status in /proc/[0-9]*/status; do "
    '[ -r "$status" ] || continue; uid=; '
    "while read key value rest; do "
    '[ "$key" = "Uid:" ] && { uid=$value; break; }; '
    'done < "$status"; '
    f'if [ "$uid" = "{RUNNER_UID}" ]; then '
    'pid=${status#/proc/}; pid=${pid%/status}; kill -KILL "$pid" 2>/dev/null || true; '
    "found=1; fi; done; "
    '[ "$found" -eq 0 ] && break; '
    "attempt=$((attempt + 1)); sleep 0.01; done; "
    "rm -rf /tmp/..?* /tmp/.[!.]* /tmp/* 2>/dev/null || exit 1; "
    "for status in /proc/[0-9]*/status; do "
    '[ -r "$status" ] || continue; uid=; '
    "while read key value rest; do "
    '[ "$key" = "Uid:" ] && { uid=$value; break; }; '
    'done < "$status"; '
    f'[ "$uid" = "{RUNNER_UID}" ] && exit 1; '
    "done; oom=; "
    "while read key value; do "
    '[ "$key" = "oom_kill" ] && { oom=$value; break; }; '
    "done < /sys/fs/cgroup/memory.events; "
    '[ -n "$oom" ] || exit 1; printf "clean %s\\n" "$oom"'
)


@dataclass
class _Session:
    token: str
    oom_count: int
    direct_container: bool = False


class DockerSessionBackend:
    """Controla contenedores persistentes sin interpolar datos del jugador."""

    def __init__(
        self,
        invoker: DockerInvoker,
        token_factory: Callable[[], str] = lambda: uuid4().hex,
        resource_owner: str | None = None,
    ) -> None:
        if resource_owner is not None and not _RESOURCE_OWNER.fullmatch(resource_owner):
            raise ValueError("resource_owner tiene un formato inválido")
        self._invoker = invoker
        self._token_factory = token_factory
        self._resource_owner = resource_owner
        self._sessions: dict[str, _Session] = {}
        self._lock = threading.Lock()

    def start(self, sandbox: SandboxSpec) -> str:
        token = self._token_factory()
        if not _TOKEN.fullmatch(token):
            raise ValueError("El token de sesión es inválido")
        direct_container = container_id_from_reference(sandbox.image)
        if direct_container is not None:
            with self._lock:
                if direct_container in self._sessions:
                    raise ValueError("La sesión Docker ya está registrada")
                self._sessions[direct_container] = _Session(token, 0, direct_container=True)
            return direct_container

        created = self._invoker.invoke(
            session_create_argv(sandbox, token, self._resource_owner),
            b"",
            CONTROL_TIMEOUT_MS,
        )
        session_id = created.stdout.decode("ascii", errors="ignore").strip()
        if not _successful(created) or not _CONTAINER_ID.fullmatch(session_id):
            self._remove_by_label(token)
            raise RuntimeError("No se pudo crear la sesión Docker")

        started = self._invoker.invoke(("docker", "start", session_id), b"", CONTROL_TIMEOUT_MS)
        if not _successful(started):
            self._remove(session_id, token)
            raise RuntimeError("No se pudo iniciar la sesión Docker")
        # El cgroup recién creado no ha podido registrar OOM; su contador inicial es cero.
        # La primera lectura remota se hace si una ejecución termina con código 137.
        oom_count = 0
        with self._lock:
            self._sessions[session_id] = _Session(token, oom_count)
        return session_id

    def supports_batch(self, sandbox: SandboxSpec) -> bool:
        """El controlador por lotes sólo se activa para Python directo."""
        return (
            container_id_from_reference(sandbox.image) is not None
            and bool(sandbox.command)
            and sandbox.command[0] in {"python", "python3"}
        )

    def run_cases_batch(
        self,
        sandbox: SandboxSpec,
        cases: Sequence[CaseInput],
        timeout_ms: int,
    ) -> list[CaseExecution]:
        """Ejecuta Python en una sola sesión Docker con limpieza por caso."""
        if not self.supports_batch(sandbox):
            raise ValueError("El controlador por lotes sólo admite Python directo")
        if not cases:
            raise ValueError("Se requiere al menos un caso")
        session_id = self.start(sandbox)
        encoded_inputs = b"".join(base64.b64encode(case.stdin) + b"\n" for case in cases)
        batch_invoker: DockerInvoker = self._invoker
        if isinstance(self._invoker, SubprocessDockerInvoker):
            batch_invoker = SubprocessDockerInvoker(
                OUTPUT_LIMIT_BYTES * len(cases) + 64 * 1024,
                self._resource_owner,
            )
        try:
            observation = batch_invoker.invoke(
                (
                    "docker",
                    "exec",
                    "--interactive",
                    "--user",
                    f"{RUNNER_UID}:{RUNNER_GID}",
                    session_id,
                    "python3",
                    "-c",
                    _BATCH_CONTROLLER,
                    "duelodev-batch",
                    str(timeout_ms),
                    *sandbox.command,
                ),
                encoded_inputs,
                timeout_ms * len(cases) + CONTROL_TIMEOUT_MS,
            )
            if observation.system_error or observation.timed_out or observation.output_exceeded:
                raise RuntimeError("El controlador del juez no completó el lote")
            records = [json.loads(line) for line in observation.stdout.splitlines()]
            if len(records) != len(cases):
                raise RuntimeError("El controlador del juez devolvió casos incompletos")
            executions: list[CaseExecution] = []
            for case, record in zip(cases, records, strict=True):
                if not isinstance(record, dict) or not record.get("clean"):
                    raise RuntimeError("El controlador del juez no confirmó la limpieza")
                try:
                    stdout = base64.b64decode(record["stdout"], validate=True)
                    stderr = base64.b64decode(record["stderr"], validate=True)
                    exit_code = int(record["exit_code"])
                    time_ms = int(record["time_ms"])
                except (KeyError, TypeError, ValueError, binascii.Error) as error:
                    raise RuntimeError("Respuesta inválida del controlador del juez") from error
                executions.append(
                    CaseExecution(
                        ordinal=case.ordinal,
                        stdout=stdout,
                        stderr=stderr,
                        exit_code=exit_code,
                        time_ms=time_ms,
                        timed_out=bool(record.get("timed_out")),
                        oom_killed=bool(record.get("oom_killed")),
                        output_exceeded=bool(record.get("output_exceeded")),
                    )
                )
            return executions
        finally:
            if not self.close(session_id):
                raise RuntimeError("No se pudo cerrar la sesión por lotes")

    def execute(
        self,
        session_id: str,
        command: tuple[str, ...],
        stdin: bytes,
        timeout_ms: int,
    ) -> RuntimeObservation:
        session = self._known(session_id)
        before_oom = session.oom_count
        observation = self._invoker.invoke(
            (
                "docker",
                "exec",
                "--interactive",
                "--user",
                f"{RUNNER_UID}:{RUNNER_GID}",
                session_id,
                *command,
            ),
            stdin,
            timeout_ms,
        )
        return self._track_oom(session_id, session, before_oom, observation)

    def execute_and_reset(
        self,
        session_id: str,
        command: tuple[str, ...],
        stdin: bytes,
        timeout_ms: int,
    ) -> tuple[RuntimeObservation, bool]:
        """Ejecuta sin privilegios y evita otra llamada Docker si prueba la limpieza."""
        session = self._known(session_id)
        before_oom = session.oom_count
        observation = self._invoker.invoke(
            (
                "docker",
                "exec",
                "--interactive",
                "--user",
                f"{RUNNER_UID}:{RUNNER_GID}",
                session_id,
                "/bin/sh",
                "-c",
                _EXECUTE_AND_RESET,
                "duelodev-session",
                *command,
            ),
            stdin,
            timeout_ms,
        )
        mapped_exit_code = {250: 137, 251: 1, 252: 0, 253: 137, 254: 1, 255: 0}.get(
            observation.exit_code
        )
        cleanup_proven = (
            observation.exit_code in {253, 254, 255}
            and not observation.timed_out
            and not observation.output_exceeded
            and not observation.system_error
        )
        if cleanup_proven:
            assert mapped_exit_code is not None
            completed = RuntimeObservation(
                observation.stdout,
                observation.stderr,
                mapped_exit_code,
                observation.time_ms,
                oom_killed=observation.oom_killed,
            )
            return self._track_oom(session_id, session, before_oom, completed), True

        # Timeout, salida excesiva o intento de matar al controlador: el borrado
        # privilegiado existente sigue siendo la barrera de recuperación.
        if mapped_exit_code is not None:
            observation = RuntimeObservation(
                observation.stdout,
                observation.stderr,
                mapped_exit_code,
                observation.time_ms,
                timed_out=observation.timed_out,
                oom_killed=observation.oom_killed,
                output_exceeded=observation.output_exceeded,
                system_error=observation.system_error,
            )
        completed = self._track_oom(session_id, session, before_oom, observation)
        return completed, self.reset(session_id)

    def _track_oom(
        self,
        session_id: str,
        session: _Session,
        before_oom: int,
        observation: RuntimeObservation,
    ) -> RuntimeObservation:
        oom_killed = observation.oom_killed
        if observation.exit_code == 137 and not observation.timed_out:
            after_oom = self._read_oom_count(session_id)
            if after_oom is None:
                return RuntimeObservation(
                    observation.stdout,
                    observation.stderr,
                    observation.exit_code,
                    observation.time_ms,
                    timed_out=observation.timed_out,
                    output_exceeded=observation.output_exceeded,
                    system_error=True,
                )
            oom_killed = after_oom > before_oom
            with self._lock:
                session.oom_count = after_oom
        return RuntimeObservation(
            observation.stdout,
            observation.stderr,
            observation.exit_code,
            observation.time_ms,
            timed_out=observation.timed_out,
            oom_killed=oom_killed,
            output_exceeded=observation.output_exceeded,
            system_error=observation.system_error,
        )

    def reset(self, session_id: str) -> bool:
        session = self._known(session_id)
        observation = self._invoker.invoke(
            ("docker", "exec", "--user", "0:0", session_id, "/bin/sh", "-c", _RESET),
            b"",
            RESET_TIMEOUT_MS,
        )
        match = re.fullmatch(rb"clean ([0-9]+)\n", observation.stdout)
        if not _successful(observation) or match is None:
            return False
        with self._lock:
            session.oom_count = int(match.group(1))
        return True

    def close(self, session_id: str) -> bool:
        session = self._known(session_id)
        removed = self._remove(session_id, session.token)
        if removed:
            with self._lock:
                self._sessions.pop(session_id, None)
        return removed

    def _known(self, session_id: str) -> _Session:
        if not _CONTAINER_ID.fullmatch(session_id):
            raise ValueError("El identificador de sesión es inválido")
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise ValueError("La sesión no pertenece a este backend")
        return session

    def _read_oom_count(self, session_id: str) -> int | None:
        observation = self._invoker.invoke(
            ("docker", "exec", "--user", "0:0", session_id, "/bin/sh", "-c", _OOM_COUNT),
            b"",
            CONTROL_TIMEOUT_MS,
        )
        try:
            value = int(observation.stdout.strip())
        except ValueError:
            return None
        return value if _successful(observation) and value >= 0 else None

    def _remove(self, session_id: str, token: str) -> bool:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is not None and session.direct_container:
            removed = self._invoker.invoke(
                ("docker", "rm", "--force", session_id), b"", CONTROL_TIMEOUT_MS
            )
            return _successful(removed)
        observation = self._invoker.invoke(
            ("docker", "rm", "--force", session_id), b"", CONTROL_TIMEOUT_MS
        )
        return _successful(observation) or self._remove_by_label(token)

    def _remove_by_label(self, token: str) -> bool:
        listed = self._invoker.invoke(
            (
                "docker",
                "ps",
                "--all",
                "--quiet",
                "--filter",
                f"label=duelodev.judge.session={token}",
            ),
            b"",
            CONTROL_TIMEOUT_MS,
        )
        if not _successful(listed):
            return False
        identifiers = listed.stdout.decode("ascii", errors="ignore").split()
        if any(not re.fullmatch(r"[0-9a-f]{12,64}", value) for value in identifiers):
            return False
        if not identifiers:
            return True
        removed = self._invoker.invoke(
            ("docker", "rm", "--force", *identifiers), b"", CONTROL_TIMEOUT_MS
        )
        return _successful(removed)


def session_create_argv(
    sandbox: SandboxSpec, token: str, resource_owner: str | None = None
) -> tuple[str, ...]:
    """Construye una sesión rootless con un controlador raíz mínimo."""
    if not _TOKEN.fullmatch(token):
        raise ValueError("El token de sesión es inválido")
    if resource_owner is not None and not _RESOURCE_OWNER.fullmatch(resource_owner):
        raise ValueError("resource_owner tiene un formato inválido")
    return (
        "docker",
        "create",
        "--init",
        "--pull",
        "never",
        "--label",
        f"duelodev.judge.session={token}",
        *(("--label", f"duelodev.judge.worker={resource_owner}") if resource_owner else ()),
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        f"/tmp:rw,noexec,nosuid,size={BOX_TMPFS_MB}m,mode=0777",
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
        f"{sandbox.memory_limit_mb}m",
        "--memory-swap",
        f"{sandbox.memory_limit_mb}m",
        "--cpus",
        str(CPU_LIMIT),
        "--pids-limit",
        str(sandbox.pids_limit),
        sandbox.image,
        "/bin/sh",
        "-c",
        _KEEPALIVE,
    )


def _successful(observation: RuntimeObservation) -> bool:
    return (
        not observation.system_error
        and not observation.timed_out
        and not observation.output_exceeded
        and observation.exit_code == 0
    )
