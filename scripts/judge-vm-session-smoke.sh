#!/usr/bin/env bash
# Verifica aislamiento, limpieza y veredictos del runner por sesión en la VM rootless.

set -euo pipefail

readonly VM_USER="judge"
readonly VM_HOST="127.0.0.1"
readonly VM_PORT="2222"
readonly REMOTE_DIR="/home/judge/duelodev-session-smoke"

ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p "$VM_PORT" \
  "${VM_USER}@${VM_HOST}" "mkdir -p '${REMOTE_DIR}/judge'"
scp -P "$VM_PORT" judge/__init__.py judge/capture.py judge/compiler.py judge/docker_compiler.py \
  judge/docker_session.py judge/evaluation.py judge/languages.py judge/limits.py judge/runtime.py \
  judge/sandbox.py judge/session_runtime.py judge/supervisor.py judge/verdicts.py \
  "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/judge/"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "PYTHONPATH='${REMOTE_DIR}' python3 - <<'PY'
import json
import subprocess

from judge.compiler import MAX_COMPILE_OUTPUT_BYTES, prepare_submission
from judge.docker_compiler import DockerCompilationBackend
from judge.docker_session import DockerSessionBackend
from judge.evaluation import evaluate_case
from judge.runtime import SubprocessDockerInvoker
from judge.sandbox import SandboxSpec
from judge.session_runtime import DockerSubmissionRunner
from judge.supervisor import CaseInput
from judge.verdicts import Verdict


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
    for status_path in Path('/proc').glob('[0-9]*/status'):
        try:
            uid_line = next(
                line for line in status_path.read_text().splitlines() if line.startswith('Uid:')
            )
        except (OSError, StopIteration):
            continue
        if int(uid_line.split()[1]) == os.getuid():
            own += 1
    assert own == 1, own
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
        chunks.append(bytearray(16 * 1024 * 1024))
        time.sleep(0.01)
else:
    raise AssertionError(mode)
'''

base_image = subprocess.check_output(
    ['docker', 'image', 'inspect', 'python:3.12-slim-bookworm', '--format', '{{index .RepoDigests 0}}'],
    text=True,
).strip()
invoker = SubprocessDockerInvoker(MAX_COMPILE_OUTPUT_BYTES)
compiler = DockerCompilationBackend(
    invoker,
    {'python': base_image, 'cpp': base_image, 'java': base_image},
)
prepared = prepare_submission(compiler, 'python', source)
assert prepared.succeeded and prepared.artifact is not None, prepared

try:
    sandbox = SandboxSpec(prepared.artifact.reference, prepared.run_argv, 500, 256)
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
    executions = DockerSubmissionRunner(DockerSessionBackend(invoker)).run_cases(
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
    ['docker', 'ps', '--all', '--quiet', '--filter', 'label=duelodev.judge.session'], text=True
).split()
assert not leftovers, leftovers
PY"
