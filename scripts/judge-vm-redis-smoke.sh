#!/usr/bin/env bash
# Verifica XREADGROUP/XACK con Redis desechable dentro de la VM rootless.

set -euo pipefail

readonly VM_USER="judge"
readonly VM_HOST="127.0.0.1"
readonly VM_PORT="2222"
readonly REMOTE_DIR="/home/judge/duelodev-redis-smoke"
readonly CONTAINER_NAME="duelodev-redis-smoke"

cleanup() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
    "docker rm -f '${CONTAINER_NAME}' >/dev/null 2>&1 || true"
}
trap cleanup EXIT

ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p "$VM_PORT" \
  "${VM_USER}@${VM_HOST}" "mkdir -p '${REMOTE_DIR}/judge'"
scp -P "$VM_PORT" judge/__init__.py judge/compiler.py judge/evaluation.py judge/languages.py \
  judge/limits.py judge/pipeline.py judge/sandbox.py judge/stream_codec.py \
  judge/stream_consumer.py judge/supervisor.py judge/verdicts.py judge/worker.py \
  "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/judge/"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "if [[ ! -x '${REMOTE_DIR}/.venv/bin/pip' ]]; then \
     python3 -m venv --clear '${REMOTE_DIR}/.venv'; \
   fi; \
   if ! '${REMOTE_DIR}/.venv/bin/python' -c 'import redis' >/dev/null 2>&1; then \
     '${REMOTE_DIR}/.venv/bin/pip' install --disable-pip-version-check redis==5.2.1; \
   fi"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "docker pull redis:7-alpine >/dev/null; \
   docker rm -f '${CONTAINER_NAME}' >/dev/null 2>&1 || true; \
   image=\$(docker image inspect redis:7-alpine --format '{{index .RepoDigests 0}}'); \
   docker run -d --rm --name '${CONTAINER_NAME}' -p 127.0.0.1:6379:6379 \
     \"\$image\" redis-server --save '' --appendonly no >/dev/null"

for attempt in $(seq 1 20); do
  if ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
    "docker exec '${CONTAINER_NAME}' redis-cli ping" 2>/dev/null | grep -qx PONG; then
    break
  fi
  if [[ "$attempt" -eq 20 ]]; then
    printf 'Redis no quedó listo dentro del plazo.\n' >&2
    exit 1
  fi
  sleep 1
done

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "PYTHONPATH='${REMOTE_DIR}' '${REMOTE_DIR}/.venv/bin/python' - <<'PY'
from time import sleep

from redis import Redis

from judge.stream_consumer import RedisPyStreamTransport, StreamConsumer
from judge.worker import EntryDisposition, EntryOutcome


class Decisions:
    def __init__(self):
        self.calls = 0

    def handle(self, message_id, fields):
        self.calls += 1
        if self.calls == 1:
            return EntryOutcome(EntryDisposition.ACK_RESULT)
        return EntryOutcome(EntryDisposition.RETRY)


client = Redis(host='127.0.0.1', port=6379, socket_timeout=2)
client.flushdb()
transport = RedisPyStreamTransport(client)
assert transport.ensure_group()
assert not transport.ensure_group()
first = client.xadd('judge:stream', {'submission_id': 'one'})
second = client.xadd('judge:stream', {'submission_id': 'two'})

stats = StreamConsumer(
    'worker-smoke',
    transport,
    Decisions(),
    count=2,
    block_ms=100,
    recovery_idle_ms=60_000,
).poll_once()
assert stats.read == 2
assert stats.acknowledged == 1
assert stats.retried == 1
pending = client.xpending('judge:stream', 'judges')
assert pending['pending'] == 1
sleep(0.02)

class Recover:
    def handle(self, message_id, fields):
        assert message_id == second.decode()
        return EntryOutcome(EntryDisposition.ACK_RESULT)

recovered = StreamConsumer(
    'worker-recovery',
    transport,
    Recover(),
    count=2,
    block_ms=100,
    recovery_idle_ms=1,
).poll_once()
assert recovered.read == 1
assert recovered.recovered == 1
assert recovered.acknowledged == 1
assert client.xpending('judge:stream', 'judges')['pending'] == 0
assert first != second
print('XREADGROUP, XAUTOCLAIM, ACK seguro y recuperación PEL verificados con Redis rootless.')
PY"
