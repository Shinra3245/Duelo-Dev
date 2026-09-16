#!/usr/bin/env bash
# Compila y ejecuta una solución controlada por lenguaje dentro de la VM rootless.

set -euo pipefail

readonly VM_USER="judge"
readonly VM_HOST="127.0.0.1"
readonly VM_PORT="2222"
readonly REMOTE_DIR="/home/judge/duelodev-compiler-smoke"

ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p "$VM_PORT" \
  "${VM_USER}@${VM_HOST}" "mkdir -p '${REMOTE_DIR}/judge'"
scp -P "$VM_PORT" judge/__init__.py judge/capture.py judge/compiler.py \
  judge/docker_compiler.py judge/evaluation.py judge/languages.py judge/limits.py \
  judge/runtime.py judge/sandbox.py judge/supervisor.py judge/verdicts.py \
  "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/judge/"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "docker pull python:3.12-slim-bookworm && \
   docker pull gcc:14-bookworm && \
   docker pull eclipse-temurin:21-jdk-jammy"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "PYTHONPATH='${REMOTE_DIR}' python3 - <<'PY'
import subprocess

from judge.compiler import MAX_COMPILE_OUTPUT_BYTES, prepare_submission
from judge.docker_compiler import DockerCompilationBackend
from judge.runtime import DockerCaseRunner, SubprocessDockerInvoker
from judge.sandbox import SandboxSpec
from judge.supervisor import JudgeCase, judge_cases
from judge.verdicts import Verdict


def repo_digest(tag):
    return subprocess.check_output(
        ['docker', 'image', 'inspect', tag, '--format', '{{index .RepoDigests 0}}'],
        text=True,
    ).strip()


base_images = {
    'python': repo_digest('python:3.12-slim-bookworm'),
    'cpp': repo_digest('gcc:14-bookworm'),
    'java': repo_digest('eclipse-temurin:21-jdk-jammy'),
}
invoker = SubprocessDockerInvoker(MAX_COMPILE_OUTPUT_BYTES)
backend = DockerCompilationBackend(invoker, base_images)
runner = DockerCaseRunner(invoker)
solutions = {
    'python': 'value = int(input())\nprint(value + 1)\n',
    'cpp': '#include <iostream>\nint main(){long long value; std::cin >> value; std::cout << value + 1 << std::endl;}\n',
    'java': 'import java.util.*; class Main { public static void main(String[] args) { Scanner s = new Scanner(System.in); System.out.println(s.nextLong() + 1); } }\n',
}

for language, source in solutions.items():
    prepared = prepare_submission(backend, language, source)
    assert prepared.succeeded, (language, prepared.verdict, prepared.compile_output, prepared.judge_error)
    assert prepared.artifact is not None
    try:
        spec = SandboxSpec(prepared.artifact.reference, prepared.run_argv, 2000)
        judged = judge_cases(
            runner,
            prepared.artifact,
            spec,
            [JudgeCase(1, b'41\n', b'42\n')],
        )
        assert judged.verdict == Verdict.AC, (language, judged)
    finally:
        assert backend.cleanup(prepared.artifact.reference)

invalid = prepare_submission(backend, 'cpp', 'int main( {')
assert invalid.verdict == Verdict.CE
assert invalid.artifact is None
assert invalid.compile_output

leftovers = subprocess.check_output(
    ['docker', 'image', 'ls', '--filter', 'reference=duelodev-artifact-*', '-q'], text=True
).strip()
assert not leftovers
print('Compilación, ejecución y limpieza verificadas para Python, C++ y Java en VM rootless.')
PY"
