#!/usr/bin/env bash
set -euo pipefail

vm_user="${JUDGE_VM_USER:-judge}"
vm_host="${JUDGE_VM_HOST:-127.0.0.1}"
vm_port="${JUDGE_VM_PORT:-2222}"
remote_dir="${JUDGE_VM_REMOTE_DIR:-/home/judge/duelodev-tournament-worker}"

ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p "$vm_port" "${vm_user}@${vm_host}" \
  "if [[ -f '${remote_dir}/worker.pid' ]]; then \
     pid=\$(cat '${remote_dir}/worker.pid'); \
     if [[ \"\$pid\" =~ ^[0-9]+$ ]] && kill -0 \"\$pid\" >/dev/null 2>&1; then \
       kill -TERM \"\$pid\" >/dev/null 2>&1 || true; \
     fi; \
     rm -f '${remote_dir}/worker.pid'; \
   fi"

printf 'Worker del juez detenido si estaba activo.\n'
