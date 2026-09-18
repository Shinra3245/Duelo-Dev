#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

vm_name="${JUDGE_VM_NAME:-duelodev-judge-dev}"
vm_user="${JUDGE_VM_USER:-judge}"
vm_host="${JUDGE_VM_HOST:-127.0.0.1}"
vm_port="${JUDGE_VM_PORT:-2222}"
remote_dir="${JUDGE_VM_REMOTE_DIR:-/home/judge/duelodev-tournament-worker}"
host_gateway="${JUDGE_HOST_GATEWAY:-10.0.2.2}"
postgres_user="${POSTGRES_USER:-duelodev}"
postgres_password="${POSTGRES_PASSWORD:-cambiame_en_local}"
postgres_db="${POSTGRES_DB:-duelodev}"
postgres_port="${POSTGRES_PORT:-5433}"
redis_port="${REDIS_PORT:-6380}"
remote_database_url="${JUDGE_DATABASE_URL:-postgresql://${postgres_user}:${postgres_password}@${host_gateway}:${postgres_port}/${postgres_db}}"
remote_redis_url="${JUDGE_REDIS_URL:-redis://${host_gateway}:${redis_port}/0}"
worker_id="${JUDGE_WORKER_ID:-tournament-vm-1}"
lease_ms="${JUDGE_LEASE_MS:-3000}"
recovery_idle_ms="${JUDGE_RECOVERY_IDLE_MS:-4000}"
batch_size="${JUDGE_BATCH_SIZE:-1}"
block_ms="${JUDGE_BLOCK_MS:-100}"

quote() {
  printf '%q' "$1"
}

ssh_base=(
  ssh
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o StrictHostKeyChecking=accept-new
  -p "$vm_port"
  "${vm_user}@${vm_host}"
)

if ! command -v VBoxManage >/dev/null 2>&1; then
  printf 'Error: VBoxManage no está disponible.\n' >&2
  exit 1
fi
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

"${ssh_base[@]}" \
  "rm -rf $(quote "$remote_dir/judge") $(quote "$remote_dir/cases"); mkdir -p $(quote "$remote_dir") $(quote "$remote_dir/cases") $(quote "$remote_dir/run") $(quote "$remote_dir/logs"); chmod 700 $(quote "$remote_dir/run")"

tar --exclude='__pycache__' --exclude='*.pyc' -czf - judge | "${ssh_base[@]}" \
  "tar -xzf - -C $(quote "$remote_dir")"

tar -C problems -czf - cases | "${ssh_base[@]}" \
  "tar -xzf - -C $(quote "$remote_dir/cases")"

"${ssh_base[@]}" \
  "REMOTE_DIR=$(quote "$remote_dir") DATABASE_URL=$(quote "$remote_database_url") REDIS_URL=$(quote "$remote_redis_url") JUDGE_WORKER_ID=$(quote "$worker_id") JUDGE_LEASE_MS=$(quote "$lease_ms") JUDGE_RECOVERY_IDLE_MS=$(quote "$recovery_idle_ms") JUDGE_BATCH_SIZE=$(quote "$batch_size") JUDGE_BLOCK_MS=$(quote "$block_ms") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

if [[ -f "${REMOTE_DIR}/worker.pid" ]]; then
  old_pid="$(cat "${REMOTE_DIR}/worker.pid")"
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
    kill -TERM "$old_pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      if ! kill -0 "$old_pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
  fi
  rm -f "${REMOTE_DIR}/worker.pid"
fi

if [[ ! -x "${REMOTE_DIR}/.venv/bin/python" ]]; then
  python3 -m venv "${REMOTE_DIR}/.venv"
fi
"${REMOTE_DIR}/.venv/bin/pip" install --disable-pip-version-check -r "${REMOTE_DIR}/judge/requirements.txt" >/dev/null

export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"

docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' | grep -qx 'name=rootless'
docker pull python:3.12-slim-bookworm >/dev/null
docker pull gcc:14-bookworm >/dev/null
docker pull eclipse-temurin:21-jdk-jammy >/dev/null
python_image="$(docker image inspect python:3.12-slim-bookworm --format '{{index .RepoDigests 0}}')"
cpp_image="$(docker image inspect gcc:14-bookworm --format '{{index .RepoDigests 0}}')"
java_image="$(docker image inspect eclipse-temurin:21-jdk-jammy --format '{{index .RepoDigests 0}}')"

"${REMOTE_DIR}/.venv/bin/python" - <<'PY'
import os
import psycopg
from redis import Redis

with psycopg.connect(os.environ['DATABASE_URL']) as connection:
    with connection.cursor() as cursor:
        cursor.execute('SELECT 1')
        assert cursor.fetchone() == (1,)
client = Redis.from_url(os.environ['REDIS_URL'])
assert client.ping() is True
client.close()
PY

nohup env \
  PYTHONPATH="${REMOTE_DIR}" \
  DATABASE_URL="${DATABASE_URL}" \
  REDIS_URL="${REDIS_URL}" \
  JUDGE_CASES_ROOT="${REMOTE_DIR}/cases" \
  JUDGE_RUNTIME_DIR="${REMOTE_DIR}/run" \
  JUDGE_WORKER_ID="${JUDGE_WORKER_ID}" \
  JUDGE_LEASE_MS="${JUDGE_LEASE_MS}" \
  JUDGE_RECOVERY_IDLE_MS="${JUDGE_RECOVERY_IDLE_MS}" \
  JUDGE_BATCH_SIZE="${JUDGE_BATCH_SIZE}" \
  JUDGE_BLOCK_MS="${JUDGE_BLOCK_MS}" \
  JUDGE_IMAGE_PYTHON="${python_image}" \
  JUDGE_IMAGE_CPP="${cpp_image}" \
  JUDGE_IMAGE_JAVA="${java_image}" \
  "${REMOTE_DIR}/.venv/bin/python" -m judge.app \
  >"${REMOTE_DIR}/logs/worker.log" 2>&1 &
worker_pid="$!"
printf '%s\n' "$worker_pid" >"${REMOTE_DIR}/worker.pid"
sleep 2
if ! kill -0 "$worker_pid" >/dev/null 2>&1; then
  cat "${REMOTE_DIR}/logs/worker.log" >&2
  exit 1
fi
printf 'Worker del juez activo en VM con pid %s.\n' "$worker_pid"
REMOTE_SCRIPT
