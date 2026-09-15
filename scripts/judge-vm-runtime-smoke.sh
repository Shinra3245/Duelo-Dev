#!/usr/bin/env bash
# Prueba controlada del supervisor y Docker rootless dentro de la VM desechable.

set -euo pipefail

readonly VM_USER="judge"
readonly VM_HOST="127.0.0.1"
readonly VM_PORT="2222"
readonly REMOTE_DIR="/home/judge/duelodev-runtime-smoke"

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
spec = SandboxSpec(image, ('sh', '-c', 'cat'), 1000)
result = DockerCaseRunner(SubprocessDockerInvoker()).run_case(
    CompiledArtifact(image), spec, b'controlled-input\\n', 1
)
assert result.stdout == b'controlled-input\\n'
assert result.exit_code == 0
assert not result.timed_out
assert not result.output_exceeded
assert not result.system_error
print('Supervisor y runtime rootless verificados en VM.')
PY"
