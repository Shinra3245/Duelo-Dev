#!/usr/bin/env bash
# Ejecuta un trabajo completo Redis -> worker -> PostgreSQL -> Pub/Sub en la VM rootless.

set -euo pipefail

readonly VM_USER="judge"
readonly VM_HOST="127.0.0.1"
readonly VM_PORT="2222"
SMOKE_SUFFIX="${JUDGE_VM_WORKER_SUFFIX:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
if [[ ! "$SMOKE_SUFFIX" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,47}$ ]]; then
  printf 'Error: JUDGE_VM_WORKER_SUFFIX debe ser alfanumérico y contener hasta 48 caracteres.\n' >&2
  exit 2
fi
readonly REMOTE_DIR="/home/judge/duelodev-worker-smoke-${SMOKE_SUFFIX}"
readonly POSTGRES_CONTAINER="duelodev-worker-postgres-${SMOKE_SUFFIX}"
readonly REDIS_CONTAINER="duelodev-worker-redis-${SMOKE_SUFFIX}"
readonly WORKER_ID="worker-e2e-${SMOKE_SUFFIX}"
readonly PG_PORT="${JUDGE_VM_WORKER_PG_PORT:-15432}"
readonly REDIS_PORT="${JUDGE_VM_WORKER_REDIS_PORT:-16379}"
for port in "$PG_PORT" "$REDIS_PORT"; do
  if [[ ! "$port" =~ ^[0-9]{4,5}$ ]] || ((10#$port < 1024 || 10#$port > 65535)); then
    printf 'Error: los puertos del smoke deben ser enteros entre 1024 y 65535.\n' >&2
    exit 2
  fi
done
if [[ "$PG_PORT" == "$REDIS_PORT" ]]; then
  printf 'Error: PostgreSQL y Redis requieren puertos distintos.\n' >&2
  exit 2
fi
REMOTE_DIR_CREATED=0
CONTAINERS_CREATED=0

cleanup() {
  if [[ "$REMOTE_DIR_CREATED" == 1 || "$CONTAINERS_CREATED" == 1 ]]; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
      "if [[ '${REMOTE_DIR_CREATED}' == 1 && -f '${REMOTE_DIR}/worker.pid' ]]; then \
         kill -TERM \$(cat '${REMOTE_DIR}/worker.pid') >/dev/null 2>&1 || true; \
       fi; \
       if [[ '${CONTAINERS_CREATED}' == 1 ]]; then \
         docker rm -f '${POSTGRES_CONTAINER}' '${REDIS_CONTAINER}' >/dev/null 2>&1 || true; \
       fi; \
       if [[ '${REMOTE_DIR_CREATED}' == 1 ]]; then rm -rf -- '${REMOTE_DIR}'; fi" \
      >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p "$VM_PORT" \
  "${VM_USER}@${VM_HOST}" \
  "set -euo pipefail; \
   test ! -e '${REMOTE_DIR}' && test ! -L '${REMOTE_DIR}'; \
   for name in '${POSTGRES_CONTAINER}' '${REDIS_CONTAINER}'; do \
     ! docker ps --all --format '{{.Names}}' | grep -Fxq \"\$name\"; \
   done; \
   ! docker ps --all --quiet --filter 'label=duelodev.judge.worker=${WORKER_ID}' | grep -q .; \
   ! docker image ls --quiet --filter 'label=duelodev.judge.worker=${WORKER_ID}' | grep -q .; \
   for port in '${PG_PORT}' '${REDIS_PORT}'; do \
     ! ss -ltnH \"sport = :\$port\" | grep -q .; \
   done"

ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p "$VM_PORT" \
  "${VM_USER}@${VM_HOST}" "mkdir '${REMOTE_DIR}'"
REMOTE_DIR_CREATED=1
ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "mkdir -p '${REMOTE_DIR}/judge' '${REMOTE_DIR}/migrations' '${REMOTE_DIR}/cases' \
    '${REMOTE_DIR}/run'; chmod 700 '${REMOTE_DIR}/run'"
scp -P "$VM_PORT" judge/*.py "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/judge/"
scp -P "$VM_PORT" judge/requirements.txt "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/"
scp -P "$VM_PORT" api/migrations/001_initial_schema.up.sql \
  api/migrations/002_judge_lease_fencing.up.sql \
  "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/migrations/"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "if [[ ! -x '${REMOTE_DIR}/.venv/bin/pip' ]]; then \
     python3 -m venv --clear '${REMOTE_DIR}/.venv'; \
   fi; \
   '${REMOTE_DIR}/.venv/bin/pip' install --disable-pip-version-check \
     -r '${REMOTE_DIR}/requirements.txt' >/dev/null"

CONTAINERS_CREATED=1
ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "docker pull postgres:16-alpine >/dev/null; \
   docker pull redis:7-alpine >/dev/null; \
   docker pull python:3.12-slim-bookworm >/dev/null; \
   docker pull gcc:14-bookworm >/dev/null; \
   docker pull eclipse-temurin:21-jdk-jammy >/dev/null; \
   postgres_image=\$(docker image inspect postgres:16-alpine --format '{{index .RepoDigests 0}}'); \
   redis_image=\$(docker image inspect redis:7-alpine --format '{{index .RepoDigests 0}}'); \
   docker run -d --rm --name '${POSTGRES_CONTAINER}' -p 127.0.0.1:${PG_PORT}:5432 \
     -e POSTGRES_USER=duelodev -e POSTGRES_PASSWORD=test -e POSTGRES_DB=duelodev_test \
     \"\$postgres_image\" >/dev/null; \
   docker run -d --rm --name '${REDIS_CONTAINER}' -p 127.0.0.1:${REDIS_PORT}:6379 \
     \"\$redis_image\" redis-server --save '' --appendonly no >/dev/null"

for attempt in $(seq 1 30); do
  if ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
    "docker exec '${POSTGRES_CONTAINER}' pg_isready -U duelodev -d duelodev_test >/dev/null && \
     docker exec '${REDIS_CONTAINER}' redis-cli ping" 2>/dev/null | grep -qx PONG; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    printf 'Los servicios del smoke no quedaron listos dentro del plazo.\n' >&2
    exit 1
  fi
  sleep 1
done

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "set -euo pipefail; \
PYTHONPATH='${REMOTE_DIR}' '${REMOTE_DIR}/.venv/bin/python' - <<'PY'
import json
from pathlib import Path
from time import sleep

import psycopg


root = Path('${REMOTE_DIR}')
problem_id = '00000000-0000-0000-0000-000000000002'
case_dir = root / 'cases' / 'cases' / problem_id / 'v1'
case_dir.mkdir(parents=True, exist_ok=True)
(case_dir / 'manifest.json').write_text(json.dumps({
    'schema_version': 1,
    'problem_id': problem_id,
    'problem_version': 1,
    'cases': [
        {'ordinal': 1, 'input': '41\n', 'expected': '42\n'},
        {'ordinal': 2, 'input': '-2\n', 'expected': '-1\n'},
    ],
}), encoding='utf-8')

dsn = 'postgresql://duelodev:test@127.0.0.1:${PG_PORT}/duelodev_test'
for attempt in range(20):
    try:
        connection = psycopg.connect(dsn)
        break
    except psycopg.OperationalError:
        if attempt == 19:
            raise
        sleep(0.25)

with connection:
    with connection.cursor() as cursor:
        for migration in ('001_initial_schema.up.sql', '002_judge_lease_fencing.up.sql'):
            cursor.execute((root / 'migrations' / migration).read_text())
        cursor.execute(
            '''
            INSERT INTO users (id, gamertag, role)
            VALUES ('00000000-0000-0000-0000-000000000001', 'player-1', 'user');
            INSERT INTO problems (
              id, title, description, category, time_limit_ms, memory_limit_mb, version, content_hash
            ) VALUES (
              '00000000-0000-0000-0000-000000000002', 'Sum one', 'Sum one', 'muy_facil',
              2000, 256, 1, repeat('a', 64)
            );
            INSERT INTO matches (id, room_code, mode, status, config, host_id)
            VALUES (
              '00000000-0000-0000-0000-000000000003', 'WORKER1', 'puntos', 'running', '{}',
              '00000000-0000-0000-0000-000000000001'
            );
            INSERT INTO submissions (
              id, match_id, round_id, user_id, problem_id, language, source_code,
              time_limit_ms, memory_limit_mb, admission_seq, status
            ) VALUES (
              '00000000-0000-0000-0000-000000000005',
              '00000000-0000-0000-0000-000000000003',
              '00000000-0000-0000-0000-000000000004',
              '00000000-0000-0000-0000-000000000001',
              '00000000-0000-0000-0000-000000000002',
              'python', 'import time; time.sleep(2); print(int(input()) + 1)',
              6000, 256, 1, 'queued'
            );
            '''
        )
PY
python_image=\$(docker image inspect python:3.12-slim-bookworm --format '{{index .RepoDigests 0}}'); \
cpp_image=\$(docker image inspect gcc:14-bookworm --format '{{index .RepoDigests 0}}'); \
java_image=\$(docker image inspect eclipse-temurin:21-jdk-jammy --format '{{index .RepoDigests 0}}'); \
start_worker() { \
  PYTHONPATH='${REMOTE_DIR}' \
  DATABASE_URL='postgresql://duelodev:test@127.0.0.1:${PG_PORT}/duelodev_test' \
  REDIS_URL='redis://127.0.0.1:${REDIS_PORT}/0' \
  JUDGE_CASES_ROOT='${REMOTE_DIR}/cases' \
  JUDGE_RUNTIME_DIR='${REMOTE_DIR}/run' \
  JUDGE_WORKER_ID='${WORKER_ID}' \
  JUDGE_LEASE_MS='3000' \
  JUDGE_RECOVERY_IDLE_MS='4000' \
  JUDGE_BLOCK_MS='100' \
  JUDGE_IMAGE_PYTHON=\"\$python_image\" \
  JUDGE_IMAGE_CPP=\"\$cpp_image\" \
  JUDGE_IMAGE_JAVA=\"\$java_image\" \
  '${REMOTE_DIR}/.venv/bin/python' -m judge.app >'${REMOTE_DIR}/worker.log' 2>&1 & \
  worker_pid=\$!; \
  printf '%s\n' \"\$worker_pid\" >'${REMOTE_DIR}/worker.pid'; \
  sleep 1; \
  if ! kill -0 \"\$worker_pid\" 2>/dev/null; then \
    cat '${REMOTE_DIR}/worker.log'; \
    exit 1; \
  fi; \
}; \
start_worker; \
PYTHONPATH='${REMOTE_DIR}' '${REMOTE_DIR}/.venv/bin/python' - <<'PY'
import json
from datetime import datetime, timezone
from time import monotonic, sleep, time

import psycopg
from redis import Redis


submission_id = '00000000-0000-0000-0000-000000000005'
client = Redis(host='127.0.0.1', port=${REDIS_PORT}, decode_responses=True)
pubsub = client.pubsub(ignore_subscribe_messages=True)
pubsub.subscribe('judge:results')
client.xadd('judge:stream', {
    'schema_version': '1',
    'submission_id': submission_id,
    'problem_id': '00000000-0000-0000-0000-000000000002',
    'problem_version': '1',
    'language': 'python',
    'source_code': 'import time; time.sleep(2); print(int(input()) + 1)',
    'time_limit_ms': '6000',
    'memory_limit_mb': '256',
    'cases_ref': 'cases/00000000-0000-0000-0000-000000000002',
    'enqueued_at_ms': str(int(time() * 1000)),
})

deadline = monotonic() + 60
started = monotonic()
notification = None
row = None
heartbeat_observed = False
while monotonic() < deadline:
    message = pubsub.get_message(timeout=0.1)
    if message and message.get('type') == 'message':
        notification = json.loads(message['data'])
    with psycopg.connect('postgresql://duelodev:test@127.0.0.1:${PG_PORT}/duelodev_test') as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                '''
                SELECT status, verdict, passed_cases, total_cases, attempt_token,
                       worker_id, lease_until
                FROM submissions WHERE id = %s
                ''',
                (submission_id,),
            )
            row = cursor.fetchone()
    if (
        row
        and row[0] == 'judging'
        and monotonic() - started > 3.2
        and row[6] is not None
        and row[6] > datetime.now(timezone.utc)
    ):
        heartbeat_observed = True
    if row and row[0] == 'completed' and notification is not None:
        break
    sleep(0.1)

assert row == ('completed', 'AC', 2, 2, None, None, None), row
assert heartbeat_observed, 'el lease no fue renovado durante el procesamiento'
assert notification == {
    'submission_id': submission_id,
    'match_id': '00000000-0000-0000-0000-000000000003',
    'round_id': '00000000-0000-0000-0000-000000000004',
    'user_id': '00000000-0000-0000-0000-000000000001',
    'verdict': 'AC',
    'passed': 2,
    'total': 2,
    'exec_time_ms': notification['exec_time_ms'],
}
assert isinstance(notification['exec_time_ms'], int) and notification['exec_time_ms'] >= 0
assert client.xpending('judge:stream', 'judges')['pending'] == 0
pubsub.close()
client.close()
print('Redis -> worker -> PostgreSQL -> judge:results verificado con AC 2/2.')
PY
kill -TERM \"\$worker_pid\"; \
wait \"\$worker_pid\"; \
test -z \"\$(docker ps --all --quiet --filter label=duelodev.judge.session)\"; \
test -z \"\$(docker image ls --quiet --filter reference=duelodev-artifact-*)\"; \
start_worker; \
PYTHONPATH='${REMOTE_DIR}' '${REMOTE_DIR}/.venv/bin/python' - <<'PY'
import subprocess
from time import monotonic, sleep, time

import psycopg
from redis import Redis


submission_id = '00000000-0000-0000-0000-000000000006'
source = 'import time; time.sleep(5); print(int(input()) + 1)'
with psycopg.connect('postgresql://duelodev:test@127.0.0.1:${PG_PORT}/duelodev_test') as connection:
    with connection.cursor() as cursor:
        cursor.execute(
            '''
            INSERT INTO submissions (
              id, match_id, round_id, user_id, problem_id, language, source_code,
              time_limit_ms, memory_limit_mb, admission_seq, status
            ) VALUES (
              %s,
              '00000000-0000-0000-0000-000000000003',
              '00000000-0000-0000-0000-000000000004',
              '00000000-0000-0000-0000-000000000001',
              '00000000-0000-0000-0000-000000000002',
              'python', %s, 6000, 256, 2, 'queued'
            )
            ''',
            (submission_id, source),
        )

client = Redis(host='127.0.0.1', port=${REDIS_PORT}, decode_responses=True)
client.xadd('judge:stream', {
    'schema_version': '1',
    'submission_id': submission_id,
    'problem_id': '00000000-0000-0000-0000-000000000002',
    'problem_version': '1',
    'language': 'python',
    'source_code': source,
    'time_limit_ms': '6000',
    'memory_limit_mb': '256',
    'cases_ref': 'cases/00000000-0000-0000-0000-000000000002',
    'enqueued_at_ms': str(int(time() * 1000)),
})

deadline = monotonic() + 30
while monotonic() < deadline:
    with psycopg.connect('postgresql://duelodev:test@127.0.0.1:${PG_PORT}/duelodev_test') as connection:
        with connection.cursor() as cursor:
            cursor.execute('SELECT status FROM submissions WHERE id = %s', (submission_id,))
            status = cursor.fetchone()[0]
    containers = subprocess.check_output(
        [
            'docker', 'ps', '--all', '--quiet', '--filter',
            'label=duelodev.judge.worker=${WORKER_ID}',
        ],
        text=True,
    ).split()
    if status == 'judging' and containers:
        break
    sleep(0.1)
else:
    raise AssertionError('el worker no alcanzó una sesión etiquetada antes del plazo')
client.close()
PY
kill -KILL \"\$worker_pid\"; \
wait \"\$worker_pid\" 2>/dev/null || true; \
test -n \"\$(docker ps --all --quiet --filter label=duelodev.judge.worker=${WORKER_ID})\"; \
sleep 5; \
start_worker; \
PYTHONPATH='${REMOTE_DIR}' '${REMOTE_DIR}/.venv/bin/python' - <<'PY'
from time import monotonic, sleep

import psycopg
from redis import Redis


submission_id = '00000000-0000-0000-0000-000000000006'
deadline = monotonic() + 60
row = None
while monotonic() < deadline:
    with psycopg.connect('postgresql://duelodev:test@127.0.0.1:${PG_PORT}/duelodev_test') as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                '''
                SELECT status, verdict, passed_cases, total_cases,
                       attempt_token, worker_id, lease_until
                FROM submissions WHERE id = %s
                ''',
                (submission_id,),
            )
            row = cursor.fetchone()
    if row and row[0] == 'completed':
        break
    sleep(0.1)

assert row == ('completed', 'AC', 2, 2, None, None, None), row
client = Redis(host='127.0.0.1', port=${REDIS_PORT}, decode_responses=True)
pending_deadline = monotonic() + 10
pending = client.xpending('judge:stream', 'judges')
while pending['pending'] != 0 and monotonic() < pending_deadline:
    sleep(0.1)
    pending = client.xpending('judge:stream', 'judges')
assert pending['pending'] == 0, pending
client.close()
print('Caída SIGKILL, limpieza selectiva, XAUTOCLAIM y reejecución AC verificados.')
PY
kill -TERM \"\$worker_pid\"; \
wait \"\$worker_pid\"; \
rm -f '${REMOTE_DIR}/worker.pid'; \
test -z \"\$(docker ps --all --quiet --filter label=duelodev.judge.worker=${WORKER_ID})\"; \
test -z \"\$(docker image ls --quiet --filter label=duelodev.judge.worker=${WORKER_ID})\""
