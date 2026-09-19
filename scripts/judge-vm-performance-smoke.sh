#!/usr/bin/env bash
set -euo pipefail

# Protocolo reproducible de rendimiento: 10 calentamientos y 100 muestras por lenguaje.
# La ejecución ocurre dentro de la VM rootless y no modifica el benchmark de carga inicial.

readonly VM_USER="${JUDGE_VM_USER:-judge}"
readonly VM_HOST="${JUDGE_VM_HOST:-127.0.0.1}"
readonly VM_PORT="${JUDGE_VM_PORT:-2222}"
readonly REMOTE_DIR="${JUDGE_VM_PERF_REMOTE_DIR:-/home/judge/duelodev-performance-smoke}"
readonly LANGUAGE="${JUDGE_PERF_LANGUAGE:-python}"
readonly SAMPLES="${JUDGE_PERF_SAMPLES:-100}"
readonly WARMUP="${JUDGE_PERF_WARMUP:-10}"
readonly WORKERS="${JUDGE_PERF_WORKERS:-3}"

case "$LANGUAGE" in
  python|cpp|java) ;;
  *) printf 'Error: JUDGE_PERF_LANGUAGE debe ser python, cpp o java.\n' >&2; exit 1 ;;
esac
for value_name in SAMPLES WARMUP WORKERS; do
  value="${!value_name}"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    printf 'Error: %s debe ser un entero positivo.\n' "$value_name" >&2
    exit 1
  fi
done

ssh_base=(
  ssh
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o StrictHostKeyChecking=accept-new
  -p "$VM_PORT"
  "${VM_USER}@${VM_HOST}"
)

if ! command -v VBoxManage >/dev/null 2>&1; then
  printf 'Error: VBoxManage no está disponible.\n' >&2
  exit 1
fi

vm_name="${JUDGE_VM_NAME:-duelodev-judge-dev}"
if ! VBoxManage showvminfo "$vm_name" --machinereadable >/dev/null 2>&1; then
  printf 'Error: la VM %s no existe.\n' "$vm_name" >&2
  exit 1
fi

vm_state="$(VBoxManage showvminfo "$vm_name" --machinereadable | awk -F= '$1 == "VMState" {gsub(/"/, "", $2); print $2}')"
if [[ "$vm_state" != "running" ]]; then
  printf 'Iniciando VM %s...\n' "$vm_name"
  VBoxManage startvm "$vm_name" --type headless >/dev/null
fi

for attempt in $(seq 1 120); do
  if "${ssh_base[@]}" 'true' >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 120 ]]; then
    printf 'Error: SSH de la VM no respondió dentro del plazo.\n' >&2
    exit 1
  fi
  sleep 1
done

"${ssh_base[@]}" "rm -rf '$REMOTE_DIR/judge' '$REMOTE_DIR/cases'; mkdir -p '$REMOTE_DIR/judge' '$REMOTE_DIR/cases'"
scp -P "$VM_PORT" \
  judge/__init__.py judge/case_store.py judge/compiler.py judge/docker_compiler.py \
  judge/evaluation.py judge/languages.py judge/limits.py judge/docker_session.py \
  judge/pipeline.py judge/runtime.py judge/sandbox.py judge/session_runtime.py \
  judge/supervisor.py judge/verdicts.py \
  "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/judge/"

tar -C problems -czf - cases | "${ssh_base[@]}" "tar -xzf - -C '$REMOTE_DIR/cases'"

"${ssh_base[@]}" \
  "REMOTE_DIR='$REMOTE_DIR' LANGUAGE='$LANGUAGE' SAMPLES='$SAMPLES' WARMUP='$WARMUP' WORKERS='$WORKERS' bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

if [[ "${LANGUAGE}" == python ]]; then
  docker pull python:3.12-slim-bookworm >/dev/null
elif [[ "${LANGUAGE}" == cpp ]]; then
  docker pull gcc:14-bookworm >/dev/null
else
  docker pull eclipse-temurin:21-jdk-jammy >/dev/null
fi
docker pull python:3.12-slim-bookworm >/dev/null
docker pull gcc:14-bookworm >/dev/null
docker pull eclipse-temurin:21-jdk-jammy >/dev/null

python_image="$(docker image inspect python:3.12-slim-bookworm --format '{{index .RepoDigests 0}}')"
cpp_image="$(docker image inspect gcc:14-bookworm --format '{{index .RepoDigests 0}}')"
java_image="$(docker image inspect eclipse-temurin:21-jdk-jammy --format '{{index .RepoDigests 0}}')"

PERF_LANGUAGE="${LANGUAGE}" PERF_SAMPLES="${SAMPLES}" PERF_WARMUP="${WARMUP}" \
PERF_WORKERS="${WORKERS}" PERF_PYTHON_IMAGE="${python_image}" PERF_CPP_IMAGE="${cpp_image}" \
PERF_JAVA_IMAGE="${java_image}" PYTHONPATH="${REMOTE_DIR}" python3 - <<'PY'
from concurrent.futures import ThreadPoolExecutor
import json
from math import ceil
import os
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


language = os.environ["PERF_LANGUAGE"]
samples = int(os.environ["PERF_SAMPLES"])
warmup = int(os.environ["PERF_WARMUP"])
workers = int(os.environ["PERF_WORKERS"])
base_images = {
    "python": os.environ["PERF_PYTHON_IMAGE"],
    "cpp": os.environ["PERF_CPP_IMAGE"],
    "java": os.environ["PERF_JAVA_IMAGE"],
}
sources = {
    "python": "import sys\nvalue = int(sys.stdin.read())\nprint(value + 1)\n",
    "cpp": "#include <iostream>\nint main() { long long value; std::cin >> value; std::cout << value + 1 << '\\n'; }\n",
    "java": "import java.util.Scanner;\npublic class Main { public static void main(String[] args) { Scanner scanner = new Scanner(System.in); long value = scanner.nextLong(); System.out.println(value + 1); } }\n",
}

invoker = SubprocessDockerInvoker(MAX_COMPILE_OUTPUT_BYTES)
backend = DockerCompilationBackend(invoker, base_images)

with tempfile.TemporaryDirectory(prefix="duelodev-performance-cases-") as case_root_value:
    case_root = Path(case_root_value)
    case_directory = case_root / "cases" / "performance-sum-one" / "v1"
    case_directory.mkdir(parents=True)
    cases = [
        {"ordinal": ordinal, "input": f"{ordinal}\n", "expected": f"{ordinal + 1}\n"}
        for ordinal in range(1, 13)
    ]
    (case_directory / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "problem_id": "performance-sum-one",
                "problem_version": 1,
                "cases": cases,
            }
        ),
        encoding="utf-8",
    )
    provider = DirectoryCasesProvider(case_root)

    def execute(index, admitted_at):
        phase = {}

        class TimedCompiler:
            def prepare(self, request):
                started = monotonic()
                result = backend.prepare(request)
                phase["compile_ms"] = round((monotonic() - started) * 1000)
                return result

        class TimedSubmissionRunner:
            def run_cases(self, artifact, sandbox, cases):
                started = monotonic()
                result = DockerSubmissionRunner(DockerSessionBackend(invoker)).run_cases(
                    artifact, sandbox, cases
                )
                phase["session_ms"] = round((monotonic() - started) * 1000)
                return result

        class TimedCleaner:
            def cleanup(self, reference):
                started = monotonic()
                result = backend.cleanup(reference)
                phase["cleanup_ms"] = round((monotonic() - started) * 1000)
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
        result = pipeline.process(
            JudgeJob(
                schema_version=1,
                submission_id=f"performance-{language}-{index}",
                problem_id="performance-sum-one",
                problem_version=1,
                language=language,
                source_code=sources[language],
                time_limit_ms=2000,
                memory_limit_mb=256,
                cases_ref="cases/performance-sum-one",
                enqueued_at_ms=int(time() * 1000),
            )
        )
        completed = monotonic()
        if result.verdict != Verdict.AC or result.passed != 12 or result.total != 12:
            return {
                "failed": True,
                "index": index,
                "verdict": result.verdict.value,
                "passed": result.passed,
                "total": result.total,
                "judge_error": result.judge_error,
            }
        return {
            "failed": False,
            **phase,
            "queue_ms": round((worker_started - admitted_at) * 1000),
            "judge_ms": round((completed - worker_started) * 1000),
            "total_ms": round((completed - admitted_at) * 1000),
        }

    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="judge-performance") as pool:
        for index in range(warmup):
            warmup_result = pool.submit(execute, f"warmup-{index}", monotonic()).result()
            if warmup_result.get("failed"):
                raise AssertionError(json.dumps(warmup_result, sort_keys=True))

        submitted = []
        for index in range(samples):
            admitted_at = monotonic()
            submitted.append(pool.submit(execute, index, admitted_at))
        measurements = [future.result() for future in submitted]

failures = [item for item in measurements if item.get("failed")]
if failures:
    raise AssertionError(json.dumps(failures[:5], sort_keys=True))

artifact_leftovers = subprocess.check_output(
    ["docker", "image", "ls", "--filter", "reference=duelodev-artifact-*", "-q"], text=True
).split()
container_leftovers = subprocess.check_output(
    [
        "docker",
        "ps",
        "-aq",
        "--filter",
        "label=duelodev.judge.session",
    ],
    text=True,
).split()
assert not artifact_leftovers and not container_leftovers

summary = {
    "language": language,
    "samples": samples,
    "warmup": warmup,
    "workers": workers,
    "cases_per_job": 12,
    "compile_p50_ms": percentile([item["compile_ms"] for item in measurements], 0.50),
    "compile_p95_ms": percentile([item["compile_ms"] for item in measurements], 0.95),
    "session_p50_ms": percentile([item["session_ms"] for item in measurements], 0.50),
    "session_p95_ms": percentile([item["session_ms"] for item in measurements], 0.95),
    "cleanup_p50_ms": percentile([item["cleanup_ms"] for item in measurements], 0.50),
    "cleanup_p95_ms": percentile([item["cleanup_ms"] for item in measurements], 0.95),
    "queue_p50_ms": percentile([item["queue_ms"] for item in measurements], 0.50),
    "queue_p95_ms": percentile([item["queue_ms"] for item in measurements], 0.95),
    "judge_p50_ms": percentile([item["judge_ms"] for item in measurements], 0.50),
    "judge_p95_ms": percentile([item["judge_ms"] for item in measurements], 0.95),
    "total_p50_ms": percentile([item["total_ms"] for item in measurements], 0.50),
    "total_p95_ms": percentile([item["total_ms"] for item in measurements], 0.95),
    "total_max_ms": max(item["total_ms"] for item in measurements),
}
summary["target_judge_p95_ms"] = 4000
summary["target_total_p95_ms"] = 8000
summary["target_judge_passed"] = summary["judge_p95_ms"] < 4000
summary["target_total_passed"] = summary["total_p95_ms"] < 8000
print(json.dumps(summary, sort_keys=True))
PY
REMOTE_SCRIPT
