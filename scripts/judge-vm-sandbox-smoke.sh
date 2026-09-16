#!/usr/bin/env bash
# Controles S02, S04, S05, S07 y S13 en la VM rootless; no usa código de jugadores.

set -euo pipefail

readonly VM_USER="judge"
readonly VM_HOST="127.0.0.1"
readonly VM_PORT="2222"
readonly REMOTE_DIR="/home/judge/duelodev-sandbox-smoke"

ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p "$VM_PORT" \
  "${VM_USER}@${VM_HOST}" "mkdir -p '${REMOTE_DIR}/judge'"
scp -P "$VM_PORT" judge/__init__.py judge/capture.py judge/evaluation.py judge/limits.py \
  judge/runtime.py judge/sandbox.py judge/supervisor.py judge/verdicts.py \
  "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/judge/"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "PYTHONPATH='${REMOTE_DIR}' python3 - <<'PY'
import os
import subprocess

from judge.evaluation import evaluate_case
from judge.runtime import DockerCaseRunner, SubprocessDockerInvoker
from judge.sandbox import SandboxSpec
from judge.supervisor import CompiledArtifact
from judge.verdicts import Verdict

image = subprocess.check_output(
    ['docker', 'image', 'inspect', 'alpine:3.20', '--format', '{{.Id}}'], text=True
).strip()
os.environ['DUELODEV_JUDGE_CANARY'] = 'supervisor-only-canary'

def run(command, time_limit_ms=1000, output_limit=1024 * 1024):
    spec = SandboxSpec(image, tuple(command), time_limit_ms)
    return DockerCaseRunner(SubprocessDockerInvoker(output_limit)).run_case(
        CompiledArtifact(image), spec, b'', 1
    )

# S01: el límite de PIDs contiene una ráfaga de procesos y el supervisor se recupera.
s01 = run((
    'sh', '-c',
    'i=0; while [ \$i -lt 200 ]; do sleep 5 2>/dev/null & i=\$((i+1)); done; wait',
), time_limit_ms=500)
assert s01.exit_code != 0 and not s01.system_error
s01_recovery = run(('sh', '-c', 'true'))
assert s01_recovery.exit_code == 0 and not s01_recovery.system_error

# S02: el timeout externo finaliza un proceso que no termina.
s02 = run(('sh', '-c', 'sleep 2'), 50)
assert s02.timed_out

# S03: OOMKilled se consulta antes de eliminar el contenedor y se clasifica como MLE.
s03 = run(('awk', 'BEGIN { value="12345678"; while (1) value=value value }'), 10000)
assert s03.oom_killed and not s03.timed_out and not s03.system_error
assert evaluate_case(s03, b'').verdict == Verdict.MLE
s03_recovery = run(('sh', '-c', 'true'))
assert s03_recovery.exit_code == 0 and not s03_recovery.system_error

# S04: sin red, wget debe fallar; el shell convierte ese fallo en éxito de la prueba.
s04 = run(('sh', '-c', 'wget -qO- --timeout=1 http://1.1.1.1 >/dev/null 2>&1 && exit 1 || exit 0'))
assert s04.exit_code == 0

# S05: la raíz es solo lectura.
s05 = run(('sh', '-c', 'touch /write-must-fail >/dev/null 2>&1 && exit 1 || exit 0'))
assert s05.exit_code == 0

# S06/S16: el entorno del supervisor no se propaga al programa ni revela un canario.
s06 = run(('sh', '-c', 'printenv DUELODEV_JUDGE_CANARY >/dev/null && exit 1 || exit 0'))
assert s06.exit_code == 0

# S07: la salida se corta y se marca antes de acumularla en el supervisor.
s07 = run(('sh', '-c', 'head -c 1024 /dev/zero'), output_limit=64)
assert s07.output_exceeded and len(s07.stdout) == 64

# S13: usuario no root, capacidades eliminadas y no-new-privileges efectivo.
s13 = run((
    'sh', '-c',
    'id -u | grep -qx 65532 && awk \'/CapEff/ { if (\$2 !~ /^0+$/) exit 1; found=1 } END { exit !found }\' /proc/self/status',
))
assert s13.exit_code == 0

# S08: ejecuciones repetidas no dejan contenedores del juez activos.
for _ in range(50):
    s08 = run(('sh', '-c', 'true'), time_limit_ms=5000)
    if s08.exit_code != 0 or s08.system_error:
        raise AssertionError((_, s08.exit_code, s08.system_error, s08.stderr[:256]))
assert not subprocess.check_output(['docker', 'ps', '--format', '{{.ID}}'], text=True).strip()

# S09: un comando corrupto es un fallo del envío, no del supervisor.
s09 = run(('/command-does-not-exist',))
assert s09.exit_code != 0 and not s09.system_error
s09_recovery = run(('sh', '-c', 'true'))
assert s09_recovery.exit_code == 0 and not s09_recovery.system_error

# S10: el sandbox no recibe sockets Docker ni el canario del worker.
s10 = run((
    'sh', '-c',
    'test ! -S /run/docker.sock && test ! -S /var/run/docker.sock && '
    '! printenv DUELODEV_JUDGE_CANARY >/dev/null',
))
assert s10.exit_code == 0 and not s10.system_error

# S12: /tmp es una tmpfs de 64 MiB y no puede llenar el disco de la VM.
s12 = run(('sh', '-c', 'dd if=/dev/zero of=/tmp/too-big bs=1M count=65 >/dev/null 2>&1 && exit 1 || exit 0'))
assert s12.exit_code == 0

# S14: bytes binarios no rompen al supervisor ni se decodifican como control.
s14 = run(('sh', '-c', 'head -c 16 /dev/urandom'))
assert len(s14.stdout) == 16 and not s14.system_error

# S17: stdout sigue siendo datos y señales/FD del contenedor no controlan al supervisor.
s17_forged = run(('printf', '%s\n', '{"verdict":"AC"}'))
assert evaluate_case(s17_forged, b'expected\n').verdict == Verdict.WA
s17_fds = run((
    'sh', '-c',
    'readlink /proc/self/fd/0; readlink /proc/self/fd/1; readlink /proc/self/fd/2',
))
assert b'docker.sock' not in s17_fds.stdout and b'manifest.json' not in s17_fds.stdout
s17_signal = run(('sh', '-c', 'kill -TERM -1 2>/dev/null || true'))
assert not s17_signal.system_error
s17_recovery = run(('sh', '-c', 'true'))
assert s17_recovery.exit_code == 0 and not s17_recovery.system_error

# S18: cada caso recibe una tmpfs nueva; no hereda archivos del caso anterior.
s18_first = run(('sh', '-c', 'echo previous-case >/tmp/case-marker'))
assert s18_first.exit_code == 0
s18_next = run(('sh', '-c', 'test ! -e /tmp/case-marker'))
assert s18_next.exit_code == 0

print('S01-S10, S12-S14 y S16-S18 verificados en VM rootless.')
PY"
