#!/usr/bin/env bash
# Verifica aislamiento, limpieza y veredictos del runner por sesión en la VM rootless.

set -euo pipefail

readonly VM_USER="judge"
readonly VM_HOST="127.0.0.1"
readonly VM_PORT="2222"
REMOTE_SUFFIX="${JUDGE_VM_SESSION_SUFFIX:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
if [[ ! "$REMOTE_SUFFIX" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$ ]]; then
  printf 'Error: JUDGE_VM_SESSION_SUFFIX debe tener hasta 48 caracteres seguros.\n' >&2
  exit 2
fi
readonly REMOTE_DIR="/home/judge/duelodev-session-${REMOTE_SUFFIX}"
REMOTE_DIR_CREATED=0

cleanup() {
  if [[ "$REMOTE_DIR_CREATED" == 1 ]]; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" \
      "${VM_USER}@${VM_HOST}" "rm -rf -- '${REMOTE_DIR}'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p "$VM_PORT" \
  "${VM_USER}@${VM_HOST}" \
  "mkdir '${REMOTE_DIR}' || exit 1; if ! mkdir '${REMOTE_DIR}/judge'; then rmdir '${REMOTE_DIR}' || true; exit 1; fi"
REMOTE_DIR_CREATED=1
scp -P "$VM_PORT" judge/__init__.py judge/capture.py judge/compiler.py judge/docker_compiler.py \
  judge/docker_session.py judge/evaluation.py judge/languages.py judge/limits.py judge/runtime.py \
  judge/sandbox.py judge/session_runtime.py judge/supervisor.py judge/verdicts.py \
  "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/judge/"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "docker pull python:3.12-slim-bookworm >/dev/null"

readonly RESOURCE_OWNER="session-smoke-${REMOTE_SUFFIX}"
ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "test -z \$(docker ps --all --quiet --filter label=duelodev.judge.worker=${RESOURCE_OWNER}) && test -z \$(docker image ls --quiet --filter label=duelodev.judge.worker=${RESOURCE_OWNER})"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "cd '${REMOTE_DIR}' && REMOTE_DIR='${REMOTE_DIR}' REMOTE_SUFFIX='${REMOTE_SUFFIX}' PYTHONPATH='${REMOTE_DIR}' python3 - <<'PY'
import os
import json
import subprocess
from pathlib import Path

import judge
from judge.compiler import MAX_COMPILE_OUTPUT_BYTES, prepare_submission
from judge.docker_compiler import DockerCompilationBackend
from judge.docker_session import DockerSessionBackend
from judge.evaluation import evaluate_case
from judge.runtime import SubprocessDockerInvoker
from judge.sandbox import SandboxSpec
from judge.session_runtime import DockerSubmissionRunner
from judge.supervisor import CaseInput
from judge.verdicts import Verdict

expected_package = Path(os.environ['REMOTE_DIR']).resolve() / 'judge'
assert Path(judge.__file__).resolve().parent == expected_package


source = r'''
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


mode = input().strip()
if mode == 'dirty':
    status = Path('/proc/self/status').read_text()
    cap_eff = next(line.split()[1] for line in status.splitlines() if line.startswith('CapEff:'))
    assert int(cap_eff, 16) == 0
    assert not Path('/var/run/docker.sock').exists()
    try:
        Path('/proc/1/environ').read_bytes()
    except PermissionError:
        pass
    else:
        raise AssertionError('player read controller environment')
    locked = Path('/tmp/locked')
    locked.mkdir()
    (locked / 'private').write_text('stale')
    locked.chmod(0)
    subprocess.Popen(
        [sys.executable, '-c', 'import time; time.sleep(60)'],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    print('secure')
elif mode == 'check':
    assert not Path('/tmp/locked').exists()
    own = 0
    trusted_pids = {os.getpid(), os.getppid()}
    for status_path in Path('/proc').glob('[0-9]*/status'):
        try:
            uid_line = next(
                line for line in status_path.read_text().splitlines() if line.startswith('Uid:')
            )
        except (OSError, StopIteration):
            continue
        pid = int(status_path.parent.name)
        if int(uid_line.split()[1]) == os.getuid() and pid not in trusted_pids:
            own += 1
    assert own == 0, own
    print('clean')
elif mode == 'tle':
    while True:
        pass
elif mode == 'ole':
    sys.stdout.write('x' * (2 * 1024 * 1024))
elif mode == 'exit137':
    os.kill(os.getpid(), signal.SIGKILL)
elif mode == 'mle':
    chunks = []
    while True:
        chunks.append(bytearray(64 * 1024 * 1024))
else:
    raise AssertionError(mode)
'''

base_image = subprocess.check_output(
    ['docker', 'image', 'inspect', 'python:3.12-slim-bookworm', '--format', '{{index .RepoDigests 0}}'],
    text=True,
).strip()
invoker = SubprocessDockerInvoker(MAX_COMPILE_OUTPUT_BYTES)
resource_owner = 'session-smoke-' + os.environ['REMOTE_SUFFIX']
compiler = DockerCompilationBackend(
    invoker,
    {'python': base_image, 'cpp': base_image, 'java': base_image},
    resource_owner,
)
prepared = prepare_submission(compiler, 'python', source)
assert prepared.succeeded and prepared.artifact is not None, prepared

try:
    sandbox = SandboxSpec(prepared.artifact.reference, prepared.run_argv, 2000, 256)
    inputs = [
        CaseInput(1, b'dirty\n'),
        CaseInput(2, b'check\n'),
        CaseInput(3, b'tle\n'),
        CaseInput(4, b'check\n'),
        CaseInput(5, b'ole\n'),
        CaseInput(6, b'check\n'),
        CaseInput(7, b'exit137\n'),
        CaseInput(8, b'mle\n'),
        CaseInput(9, b'check\n'),
    ]
    expected = [b'secure\n', b'clean\n', b'', b'clean\n', b'', b'clean\n', b'', b'', b'clean\n']
    wanted = [
        Verdict.AC,
        Verdict.AC,
        Verdict.TLE,
        Verdict.AC,
        Verdict.OLE,
        Verdict.AC,
        Verdict.RE,
        Verdict.MLE,
        Verdict.AC,
    ]
    executions = DockerSubmissionRunner(
        DockerSessionBackend(invoker, resource_owner=resource_owner)
    ).run_cases(
        prepared.artifact, sandbox, inputs
    )
    results = [
        evaluate_case(execution, answer)
        for execution, answer in zip(executions, expected, strict=True)
    ]
    actual = [result.verdict for result in results]
    assert actual == wanted, [(value.value, execution.exit_code) for value, execution in zip(actual, executions)]
    print(json.dumps({
        'verdicts': [value.value for value in actual],
        'times_ms': [execution.time_ms for execution in executions],
        'session_security': 'passed',
    }, sort_keys=True))
finally:
    assert compiler.cleanup(prepared.artifact.reference)

leftovers = subprocess.check_output(
    [
        'docker',
        'ps',
        '--all',
        '--quiet',
        '--filter', f'label=duelodev.judge.worker={resource_owner}',
    ],
    text=True,
).split()
artifact_leftovers = subprocess.check_output(
    [
        'docker',
        'image',
        'ls',
        '--quiet',
        '--filter', f'label=duelodev.judge.worker={resource_owner}',
    ],
    text=True,
).split()
assert not leftovers and not artifact_leftovers, (leftovers, artifact_leftovers)
PY"
