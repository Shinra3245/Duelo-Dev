#!/usr/bin/env bash
# Referencias versionadas; ninguna solución se ejecuta en el host.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
suffix="${JUDGE_VM_CATALOG_SUFFIX:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
if [[ ! "$suffix" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,47}$ ]]; then
  printf 'Error: sufijo de catálogo inválido.\n' >&2
  exit 2
fi
readonly remote_dir="/home/judge/duelodev-catalog-${suffix}"
readonly vm_target="judge@127.0.0.1"
ssh_base=(ssh -o BatchMode=yes -o ConnectTimeout=10 -p 2222 "$vm_target")
created=0
cleanup() {
  if [[ "$created" == 1 ]]; then
    "${ssh_base[@]}" "rm -rf -- '${remote_dir}'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

bash scripts/judge-vm-verify-rootless.sh
catalog="$(node scripts/lib/problem-catalog.mjs)"
"${ssh_base[@]}" "mkdir -- '${remote_dir}'"
created=1
tar --exclude='__pycache__' --exclude='*.pyc' -czf - judge problems/cases problems/reference-solutions |
  "${ssh_base[@]}" "tar -xzf - -C '${remote_dir}'"
"${ssh_base[@]}" 'docker pull python:3.12-slim-bookworm >/dev/null && docker pull gcc:14-bookworm >/dev/null && docker pull eclipse-temurin:21-jdk-jammy >/dev/null'
printf '%s' "$catalog" | "${ssh_base[@]}" "cd '${remote_dir}' && PYTHONPATH='${remote_dir}' python3 -m judge.catalog_smoke"
