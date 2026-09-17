#!/usr/bin/env bash
# Verifica en la VM rootless que la limpieza por worker no borra recursos ajenos.

set -euo pipefail

readonly VM_USER="judge"
readonly VM_HOST="127.0.0.1"
readonly VM_PORT="2222"
readonly REMOTE_DIR="/home/judge/duelodev-resource-isolation-smoke"

cleanup() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
    "docker rm -f duelodev-iso-a duelodev-iso-b >/dev/null 2>&1 || true; \
     docker image rm -f duelodev-iso-a:latest duelodev-iso-b:latest >/dev/null 2>&1 || true; \
     rm -rf '${REMOTE_DIR}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p "$VM_PORT" \
  "${VM_USER}@${VM_HOST}" \
  "mkdir -p '${REMOTE_DIR}/judge' '${REMOTE_DIR}/build-a' '${REMOTE_DIR}/build-b'"
scp -P "$VM_PORT" judge/__init__.py judge/resources.py "${VM_USER}@${VM_HOST}:${REMOTE_DIR}/judge/"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$VM_PORT" "${VM_USER}@${VM_HOST}" \
  "set -euo pipefail; \
   docker pull alpine:3.20 >/dev/null; \
   cat >'${REMOTE_DIR}/build-a/Dockerfile' <<'EOF'
FROM scratch
LABEL duelodev.judge.worker=worker-iso-a
EOF
   cat >'${REMOTE_DIR}/build-b/Dockerfile' <<'EOF'
FROM scratch
LABEL duelodev.judge.worker=worker-iso-b
EOF
   docker build -q -t duelodev-iso-a:latest '${REMOTE_DIR}/build-a' >/dev/null; \
   docker build -q -t duelodev-iso-b:latest '${REMOTE_DIR}/build-b' >/dev/null; \
   alpine_image=\$(docker image inspect alpine:3.20 --format '{{index .RepoDigests 0}}'); \
   docker create --name duelodev-iso-a --label duelodev.judge.worker=worker-iso-a \
     \"\$alpine_image\" true >/dev/null; \
   docker create --name duelodev-iso-b --label duelodev.judge.worker=worker-iso-b \
     \"\$alpine_image\" true >/dev/null; \
   PYTHONPATH='${REMOTE_DIR}' python3 - <<'PY'
from judge.resources import cleanup_worker_resources

cleanup_worker_resources('worker-iso-a')
PY
   test -z \"\$(docker ps --all --quiet --filter name=duelodev-iso-a)\"; \
   test -z \"\$(docker image ls --quiet duelodev-iso-a:latest)\"; \
   test -n \"\$(docker ps --all --quiet --filter name=duelodev-iso-b)\"; \
   test -n \"\$(docker image ls --quiet duelodev-iso-b:latest)\"; \
   PYTHONPATH='${REMOTE_DIR}' python3 - <<'PY'
from judge.resources import cleanup_worker_resources

cleanup_worker_resources('worker-iso-b')
PY
   test -z \"\$(docker ps --all --quiet --filter name=duelodev-iso-b)\"; \
   test -z \"\$(docker image ls --quiet duelodev-iso-b:latest)\"; \
   printf 'Limpieza selectiva por worker verificada sin borrar recursos ajenos.\n'"
