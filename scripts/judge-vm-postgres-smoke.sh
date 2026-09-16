#!/usr/bin/env bash
# Verifica claim concurrente, fencing y rechazos durables con PostgreSQL real en la VM.

set -euo pipefail

readonly VM_USER="judge"
readonly VM_HOST="127.0.0.1"
readonly VM_PORT="2222"
readonly REMOTE_DIR="/home/judge/duelodev-postgres-smoke"
readonly CONTAINER_NAME="duelodev-postgres-smoke"

cleanup() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
    "docker rm -f '${CONTAINER_NAME}' >/dev/null 2>&1 || true"
}
trap cleanup EXIT

ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p "$VM_PORT" \
  "${VM_USER}@${VM_HOST}" "mkdir -p '${REMOTE_DIR}/judge' '${REMOTE_DIR}/migrations'"
scp -P "$VM_PORT" judge/*.py "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/judge/"
scp -P "$VM_PORT" api/migrations/001_initial_schema.up.sql \
  api/migrations/002_judge_lease_fencing.up.sql \
  "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/migrations/"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "if [[ ! -x '${REMOTE_DIR}/.venv/bin/pip' ]]; then \
     python3 -m venv --clear '${REMOTE_DIR}/.venv'; \
   fi; \
   if ! '${REMOTE_DIR}/.venv/bin/python' -c 'import psycopg' >/dev/null 2>&1; then \
     '${REMOTE_DIR}/.venv/bin/pip' install --disable-pip-version-check 'psycopg[binary]==3.2.3'; \
   fi"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "docker pull postgres:16-alpine >/dev/null; \
   docker rm -f '${CONTAINER_NAME}' >/dev/null 2>&1 || true; \
   image=\$(docker image inspect postgres:16-alpine --format '{{index .RepoDigests 0}}'); \
   docker run -d --rm --name '${CONTAINER_NAME}' -p 127.0.0.1:5432:5432 \
     -e POSTGRES_USER=duelodev -e POSTGRES_PASSWORD=test -e POSTGRES_DB=duelodev_test \
     \"\$image\" >/dev/null"

for attempt in $(seq 1 30); do
  if ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
    "docker exec '${CONTAINER_NAME}' pg_isready -U duelodev -d duelodev_test" \
    2>/dev/null | grep -q 'accepting connections'; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    printf 'PostgreSQL no quedó listo dentro del plazo.\n' >&2
    exit 1
  fi
  sleep 1
done

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "PYTHONPATH='${REMOTE_DIR}' '${REMOTE_DIR}/.venv/bin/python' - <<'PY'
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from time import sleep

import psycopg

from judge.pipeline import DurableJudgeResult, JudgeJob
from judge.postgres_repository import PostgresRejectedEntryRepository, PostgresResultRepository
from judge.verdicts import Verdict
from judge.worker import ClaimStatus, PersistStatus


dsn = 'postgresql://duelodev:test@127.0.0.1:5432/duelodev_test'
connect = lambda: psycopg.connect(dsn)

with connect() as connection:
    with connection.cursor() as cursor:
        for migration in ('001_initial_schema.up.sql', '002_judge_lease_fencing.up.sql'):
            cursor.execute(Path('${REMOTE_DIR}/migrations', migration).read_text())
        cursor.execute(
            '''
            INSERT INTO users (id, gamertag, role)
            VALUES ('00000000-0000-0000-0000-000000000001', 'player-1', 'user');
            INSERT INTO problems (
              id, title, description, category, time_limit_ms, memory_limit_mb, version, content_hash
            ) VALUES (
              '00000000-0000-0000-0000-000000000002', 'Echo', 'Echo', 'muy_facil',
              2000, 256, 3, repeat('a', 64)
            );
            INSERT INTO matches (id, room_code, mode, status, config, host_id)
            VALUES (
              '00000000-0000-0000-0000-000000000003', 'SMOKE1', 'puntos', 'running', '{}',
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
              'python', 'print(input())', 6000, 256, 1, 'queued'
            );
            '''
        )

job = JudgeJob(
    schema_version=1,
    submission_id='00000000-0000-0000-0000-000000000005',
    problem_id='00000000-0000-0000-0000-000000000002',
    problem_version=3,
    language='python',
    source_code='print(input())',
    time_limit_ms=6000,
    memory_limit_mb=256,
    cases_ref='problem/version-3',
    enqueued_at_ms=1_700_000_000_000,
)
repository = PostgresResultRepository(connect, lease_duration_ms=120_000)
barrier = Barrier(2)


def concurrent_claim(worker):
    barrier.wait()
    return repository.claim(job, worker)

with ThreadPoolExecutor(max_workers=2) as pool:
    first, second = tuple(pool.map(concurrent_claim, ('worker-1', 'worker-2')))
claims = (first, second)
assert sorted(claim.status for claim in claims) == [ClaimStatus.ACQUIRED, ClaimStatus.BUSY]
original = next(claim for claim in claims if claim.status == ClaimStatus.ACQUIRED)
assert original.attempt_token is not None

with connect() as connection:
    with connection.cursor() as cursor:
        cursor.execute('SELECT lease_until FROM submissions WHERE id = %s', (job.submission_id,))
        lease_before = cursor.fetchone()[0]
sleep(0.02)
assert repository.renew(job, 'worker-1' if first.status == ClaimStatus.ACQUIRED else 'worker-2', original.attempt_token)
with connect() as connection:
    with connection.cursor() as cursor:
        cursor.execute('SELECT lease_until FROM submissions WHERE id = %s', (job.submission_id,))
        assert cursor.fetchone()[0] > lease_before

with connect() as connection:
    with connection.cursor() as cursor:
        cursor.execute(
            '''
            UPDATE submissions
            SET lease_until = clock_timestamp() - interval '1 second'
            WHERE id = %s
            ''',
            (job.submission_id,),
        )

replacement = repository.claim(job, 'worker-recovery')
assert replacement.status == ClaimStatus.ACQUIRED
assert replacement.attempt_token is not None
assert replacement.attempt_token != original.attempt_token

result = DurableJudgeResult(
    job.submission_id,
    Verdict.AC,
    12,
    12,
    321,
    1_700_000_000_500,
)
assert repository.persist_if_current(result, original.attempt_token) == PersistStatus.FENCED
assert repository.persist_if_current(result, replacement.attempt_token) == PersistStatus.STORED
assert repository.persist_if_current(result, replacement.attempt_token) == PersistStatus.COMPLETED

rejected = PostgresRejectedEntryRepository(connect)
assert rejected.record_rejected('1700000000000-0', 'x' * 2000)
assert rejected.record_rejected('1700000000000-0', 'duplicado')

with connect() as connection:
    with connection.cursor() as cursor:
        cursor.execute(
            '''
            SELECT status, verdict, attempt_token, worker_id, lease_until
            FROM submissions WHERE id = %s
            ''',
            (job.submission_id,),
        )
        assert cursor.fetchone() == ('completed', 'AC', None, None, None)
        cursor.execute('SELECT count(*), length(max(reason)) FROM judge_rejected_messages')
        assert cursor.fetchone() == (1, 1024)

print('Claim concurrente, recuperación, fencing, persistencia e idempotencia verificados.')
PY"
