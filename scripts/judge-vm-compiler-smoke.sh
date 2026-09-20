#!/usr/bin/env bash
# Compila y ejecuta una solución controlada por lenguaje dentro de la VM rootless.

set -euo pipefail

readonly VM_USER="judge"
readonly VM_HOST="127.0.0.1"
readonly VM_PORT="2222"
SMOKE_SUFFIX="${JUDGE_VM_COMPILER_SUFFIX:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
if [[ ! "$SMOKE_SUFFIX" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,47}$ ]]; then
  printf 'Error: JUDGE_VM_COMPILER_SUFFIX debe ser alfanumérico y contener hasta 48 caracteres.\n' >&2
  exit 2
fi
readonly REMOTE_DIR="/home/judge/duelodev-compiler-smoke-${SMOKE_SUFFIX}"
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
scp -P "$VM_PORT" judge/__init__.py judge/capture.py judge/case_store.py judge/compiler.py \
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
import json
from pathlib import Path
import tempfile

from judge.case_store import DirectoryCasesProvider
from judge.compiler import MAX_COMPILE_OUTPUT_BYTES, prepare_submission
from judge.docker_compiler import DockerCompilationBackend
from judge.pipeline import JudgeJob, JudgePipeline
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
case_store = tempfile.TemporaryDirectory(prefix='duelodev-cases-')
case_root = Path(case_store.name)
case_directory = case_root / 'cases' / 'sum-one' / 'v1'
case_directory.mkdir(parents=True)
(case_directory / 'manifest.json').write_text(json.dumps({
    'schema_version': 1,
    'problem_id': 'sum-one',
    'problem_version': 1,
    'cases': [{'ordinal': 1, 'input': '41\n', 'expected': '42\n'}],
}), encoding='utf-8')
pipeline = JudgePipeline(
    DirectoryCasesProvider(case_root),
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
        cases_ref='cases/sum-one',
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
    cases_ref='cases/sum-one',
    enqueued_at_ms=int(time.time() * 1000),
))
assert invalid.verdict == Verdict.CE
assert invalid.compile_output

# S11: un artefacto posterior no puede leer el código del envío anterior.
marker = 'cross-submission-secret-7f31'
first_source = '# ' + marker + '\nprint(' + repr('first') + ')\n'
first = prepare_submission(backend, 'python', first_source)
assert first.succeeded and first.artifact is not None
try:
    first_result = judge_cases(
        runner,
        first.artifact,
        SandboxSpec(first.artifact.reference, first.run_argv, 2000),
        [JudgeCase(1, b'', b'first\n')],
    )
    assert first_result.verdict == Verdict.AC
finally:
    assert backend.cleanup(first.artifact.reference)

marker_codes = ','.join(str(ord(character)) for character in marker)
scanner_source = f'''from pathlib import Path
marker = bytes([{marker_codes}])
found = any(marker in path.read_bytes() for path in Path('/app').rglob('*') if path.is_file())
print('leaked' if found else 'isolated')
'''
second = prepare_submission(backend, 'python', scanner_source)
assert marker not in scanner_source
assert second.succeeded and second.artifact is not None
try:
    second_result = judge_cases(
        runner,
        second.artifact,
        SandboxSpec(second.artifact.reference, second.run_argv, 2000),
        [JudgeCase(1, b'', b'isolated\n')],
    )
    assert second_result.verdict == Verdict.AC
finally:
    assert backend.cleanup(second.artifact.reference)

# S15: una referencia autorizada no puede atravesar un componente symlink.
(case_root / 'cases' / 'linked-problem').symlink_to(case_directory, target_is_directory=True)
try:
    DirectoryCasesProvider(case_root).load_cases('cases/linked-problem', 'linked-problem', 1)
except ValueError:
    pass
else:
    raise AssertionError('El proveedor siguió un symlink de casos')

case_store.cleanup()

leftovers = subprocess.check_output(
    ['docker', 'image', 'ls', '--filter', 'reference=duelodev-artifact-*', '-q'], text=True
).strip()
assert not leftovers
print('Compilación, ejecución y limpieza verificadas para Python, C++ y Java en VM rootless.')
PY"
