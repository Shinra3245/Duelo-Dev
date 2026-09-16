#!/usr/bin/env bash
# Carga inicial: 10 envíos simultáneos, 3 workers y 12 casos dentro de la VM rootless.

set -euo pipefail

readonly VM_USER="judge"
readonly VM_HOST="127.0.0.1"
readonly VM_PORT="2222"
readonly REMOTE_DIR="/home/judge/duelodev-load-smoke"

ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p "$VM_PORT" \
  "${VM_USER}@${VM_HOST}" "mkdir -p '${REMOTE_DIR}/judge'"
scp -P "$VM_PORT" judge/__init__.py judge/capture.py judge/case_store.py judge/compiler.py \
  judge/docker_compiler.py judge/evaluation.py judge/languages.py judge/limits.py \
  judge/docker_session.py judge/pipeline.py judge/runtime.py judge/sandbox.py \
  judge/session_runtime.py judge/supervisor.py judge/verdicts.py \
  "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/judge/"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "docker pull python:3.12-slim-bookworm >/dev/null"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "PYTHONPATH='${REMOTE_DIR}' python3 - <<'PY'
from concurrent.futures import ThreadPoolExecutor
import json
from math import ceil
from pathlib import Path
import subprocess
import tempfile
from time import monotonic, time

from judge.case_store import DirectoryCasesProvider
from judge.compiler import MAX_COMPILE_OUTPUT_BYTES
from judge.docker_compiler import DockerCompilationBackend
from judge.docker_session import DockerSessionBackend
from judge.pipeline import JudgeJob, JudgePipeline
from judge.runtime import DockerCaseRunner, SubprocessDockerInvoker
from judge.session_runtime import DockerSubmissionRunner
from judge.verdicts import Verdict


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, ceil(len(ordered) * fraction) - 1)]


python_image = subprocess.check_output(
    ['docker', 'image', 'inspect', 'python:3.12-slim-bookworm', '--format', '{{index .RepoDigests 0}}'],
    text=True,
).strip()
base_images = {'python': python_image, 'cpp': python_image, 'java': python_image}
invoker = SubprocessDockerInvoker(MAX_COMPILE_OUTPUT_BYTES)
backend = DockerCompilationBackend(invoker, base_images)

with tempfile.TemporaryDirectory(prefix='duelodev-load-cases-') as case_root_value:
    case_root = Path(case_root_value)
    case_directory = case_root / 'cases' / 'load-sum-one' / 'v1'
    case_directory.mkdir(parents=True)
    cases = [
        {'ordinal': ordinal, 'input': f'{ordinal}\n', 'expected': f'{ordinal + 1}\n'}
        for ordinal in range(1, 13)
    ]
    (case_directory / 'manifest.json').write_text(json.dumps({
        'schema_version': 1,
        'problem_id': 'load-sum-one',
        'problem_version': 1,
        'cases': cases,
    }), encoding='utf-8')
    provider = DirectoryCasesProvider(case_root)
    admitted_at = monotonic()

    def execute(index):
        phase = {}

        class TimedCompiler:
            def prepare(self, request):
                started = monotonic()
                result = backend.prepare(request)
                phase['compile_ms'] = round((monotonic() - started) * 1000)
                return result

        class TimedSubmissionRunner:
            def __init__(self):
                self.delegate = DockerSubmissionRunner(DockerSessionBackend(invoker))

            def run_cases(self, artifact, sandbox, cases):
                started = monotonic()
                result = self.delegate.run_cases(artifact, sandbox, cases)
                phase['session_ms'] = round((monotonic() - started) * 1000)
                return result

        class TimedCleaner:
            def cleanup(self, reference):
                started = monotonic()
                result = backend.cleanup(reference)
                phase['cleanup_ms'] = round((monotonic() - started) * 1000)
                return result

        pipeline = JudgePipeline(
            provider,
            TimedCompiler(),
            DockerCaseRunner(invoker),
            TimedCleaner(),
            lambda: int(time() * 1000),
            submission_runner=TimedSubmissionRunner(),
        )
        worker_started = monotonic()
        result = pipeline.process(JudgeJob(
            schema_version=1,
            submission_id=f'load-{index}',
            problem_id='load-sum-one',
            problem_version=1,
            language='python',
            source_code='value = int(input())\nprint(value + 1)\n',
            time_limit_ms=2000,
            memory_limit_mb=256,
            cases_ref='cases/load-sum-one',
            enqueued_at_ms=int(time() * 1000),
        ))
        completed = monotonic()
        assert result.verdict == Verdict.AC and result.passed == 12 and result.total == 12
        return {
            **phase,
            'queue_ms': round((worker_started - admitted_at) * 1000),
            'judge_ms': round((completed - worker_started) * 1000),
            'total_ms': round((completed - admitted_at) * 1000),
        }

    with ThreadPoolExecutor(max_workers=3, thread_name_prefix='judge-load') as pool:
        measurements = list(pool.map(execute, range(10)))

artifact_leftovers = subprocess.check_output(
    ['docker', 'image', 'ls', '--filter', 'reference=duelodev-artifact-*', '-q'], text=True
).split()
container_leftovers = subprocess.check_output(
    ['docker', 'ps', '-aq', '--filter', 'label=duelodev.judge.run'], text=True
).split()
assert not artifact_leftovers and not container_leftovers

summary = {
    'jobs': len(measurements),
    'workers': 3,
    'cases_per_job': 12,
    'compile_p50_ms': percentile([item['compile_ms'] for item in measurements], 0.50),
    'compile_p95_ms': percentile([item['compile_ms'] for item in measurements], 0.95),
    'session_p50_ms': percentile([item['session_ms'] for item in measurements], 0.50),
    'session_p95_ms': percentile([item['session_ms'] for item in measurements], 0.95),
    'cleanup_p50_ms': percentile([item['cleanup_ms'] for item in measurements], 0.50),
    'cleanup_p95_ms': percentile([item['cleanup_ms'] for item in measurements], 0.95),
    'queue_p50_ms': percentile([item['queue_ms'] for item in measurements], 0.50),
    'queue_p95_ms': percentile([item['queue_ms'] for item in measurements], 0.95),
    'judge_p50_ms': percentile([item['judge_ms'] for item in measurements], 0.50),
    'judge_p95_ms': percentile([item['judge_ms'] for item in measurements], 0.95),
    'total_p50_ms': percentile([item['total_ms'] for item in measurements], 0.50),
    'total_p95_ms': percentile([item['total_ms'] for item in measurements], 0.95),
    'total_max_ms': max(item['total_ms'] for item in measurements),
}
assert summary['total_max_ms'] < 60000
print(json.dumps(summary, sort_keys=True))
PY"
