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
  judge/pipeline.py judge/runtime.py judge/sandbox.py judge/supervisor.py judge/verdicts.py \
  "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/judge/"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "docker pull python:3.12-slim-bookworm && \
   docker pull gcc:14-bookworm && \
   docker pull eclipse-temurin:21-jdk-jammy"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "PYTHONPATH='${REMOTE_DIR}' python3 - <<'PY'
import subprocess
import time

from judge.compiler import MAX_COMPILE_OUTPUT_BYTES
from judge.docker_compiler import DockerCompilationBackend
from judge.pipeline import JudgeJob, JudgePipeline
from judge.runtime import DockerCaseRunner, SubprocessDockerInvoker
from judge.supervisor import JudgeCase
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


class StaticCasesProvider:
    def load_cases(self, cases_ref, problem_id, problem_version):
        assert cases_ref == 'pilot/sum-one/v1'
        assert problem_id == 'sum-one'
        assert problem_version == 1
        return [JudgeCase(1, b'41\n', b'42\n')]


pipeline = JudgePipeline(
    StaticCasesProvider(),
    backend,
    runner,
    backend,
    lambda: int(time.time() * 1000),
)
solutions = {
    'python': 'value = int(input())\nprint(value + 1)\n',
    'cpp': '#include <iostream>\nint main(){long long value; std::cin >> value; std::cout << value + 1 << std::endl;}\n',
    'java': 'import java.util.*; class Main { public static void main(String[] args) { Scanner s = new Scanner(System.in); System.out.println(s.nextLong() + 1); } }\n',
}

for language, source in solutions.items():
    judged = pipeline.process(JudgeJob(
        schema_version=1,
        submission_id=f'smoke-{language}',
        problem_id='sum-one',
        problem_version=1,
        language=language,
        source_code=source,
        time_limit_ms=2000,
        memory_limit_mb=256,
        cases_ref='pilot/sum-one/v1',
        enqueued_at_ms=int(time.time() * 1000),
    ))
    assert judged.verdict == Verdict.AC, (language, judged)
    assert judged.passed == 1 and judged.total == 1

invalid = pipeline.process(JudgeJob(
    schema_version=1,
    submission_id='smoke-cpp-ce',
    problem_id='sum-one',
    problem_version=1,
    language='cpp',
    source_code='int main( {',
    time_limit_ms=2000,
    memory_limit_mb=256,
    cases_ref='pilot/sum-one/v1',
    enqueued_at_ms=int(time.time() * 1000),
))
assert invalid.verdict == Verdict.CE
assert invalid.compile_output

leftovers = subprocess.check_output(
    ['docker', 'image', 'ls', '--filter', 'reference=duelodev-artifact-*', '-q'], text=True
).strip()
assert not leftovers
print('Compilación, ejecución y limpieza verificadas para Python, C++ y Java en VM rootless.')
PY"
