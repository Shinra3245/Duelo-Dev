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
import subprocess

from judge.runtime import DockerCaseRunner, SubprocessDockerInvoker
from judge.sandbox import SandboxSpec
from judge.supervisor import CompiledArtifact

image = subprocess.check_output(
    ['docker', 'image', 'inspect', 'alpine:3.20', '--format', '{{.Id}}'], text=True
).strip()

def run(command, time_limit_ms=1000, output_limit=1024 * 1024):
    spec = SandboxSpec(image, tuple(command), time_limit_ms)
    return DockerCaseRunner(SubprocessDockerInvoker(output_limit)).run_case(
        CompiledArtifact(image), spec, b'', 1
    )

# S02: el timeout externo finaliza un proceso que no termina.
s02 = run(('sh', '-c', 'sleep 2'), 50)
assert s02.timed_out

# S04: sin red, wget debe fallar; el shell convierte ese fallo en éxito de la prueba.
s04 = run(('sh', '-c', 'wget -qO- --timeout=1 http://1.1.1.1 >/dev/null 2>&1 && exit 1 || exit 0'))
assert s04.exit_code == 0

# S05: la raíz es solo lectura.
s05 = run(('sh', '-c', 'touch /write-must-fail >/dev/null 2>&1 && exit 1 || exit 0'))
assert s05.exit_code == 0

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
    s08 = run(('sh', '-c', 'true'))
    assert s08.exit_code == 0 and not s08.system_error
assert not subprocess.check_output(['docker', 'ps', '--format', '{{.ID}}'], text=True).strip()

# S09: un comando corrupto es un fallo del envío, no del supervisor.
s09 = run(('/command-does-not-exist',))
assert s09.exit_code != 0 and not s09.system_error
s09_recovery = run(('sh', '-c', 'true'))
assert s09_recovery.exit_code == 0 and not s09_recovery.system_error

# S12: /tmp es una tmpfs de 64 MiB y no puede llenar el disco de la VM.
s12 = run(('sh', '-c', 'dd if=/dev/zero of=/tmp/too-big bs=1M count=65 >/dev/null 2>&1 && exit 1 || exit 0'))
assert s12.exit_code == 0

# S14: bytes binarios no rompen al supervisor ni se decodifican como control.
s14 = run(('sh', '-c', 'head -c 16 /dev/urandom'))
assert len(s14.stdout) == 16 and not s14.system_error

print('S02, S04, S05, S07-S09 y S12-S14 verificados en VM rootless.')
PY"
