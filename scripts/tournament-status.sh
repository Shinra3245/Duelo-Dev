#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

load_env_defaults() {
  if [[ ! -f .env ]]; then
    return 0
  fi
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#${line%%[![:space:]]*}}"
    line="${line%${line##*[![:space:]]}}"
    [[ -z "$line" || "${line:0:1}" == '#' ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < .env
}

detect_lan_host() {
  if [[ -n "${LAN_HOST:-}" ]]; then
    printf '%s\n' "$LAN_HOST"
    return
  fi
  if command -v ip >/dev/null 2>&1; then
    local detected
    detected="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}')"
    if [[ -n "$detected" ]]; then
      printf '%s\n' "$detected"
      return
    fi
  fi
  hostname -I 2>/dev/null | awk '{print $1}'
}

print_port_status() {
  local port="$1"
  local label="$2"
  if ! command -v ss >/dev/null 2>&1; then
    printf '  %s:%s -> no verificable; falta ss\n' "$label" "$port"
    return
  fi

  local listeners
  listeners="$(ss -H -ltnp "sport = :${port}" 2>/dev/null || true)"
  if [[ -z "$listeners" ]]; then
    printf '  %s:%s -> libre\n' "$label" "$port"
  else
    printf '  %s:%s -> ocupado\n' "$label" "$port"
    sed 's/^/    /' <<< "$listeners"
  fi
}

print_docker_status() {
  if ! command -v docker >/dev/null 2>&1; then
    printf 'Docker: no disponible\n'
    return
  fi

  if ! docker compose version >/dev/null 2>&1; then
    printf 'Docker Compose: no disponible\n'
    return
  fi

  printf 'Docker Compose:\n'
  if ! docker compose ps --format 'table {{.Name}}\t{{.State}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | sed 's/^/  /'; then
    printf '  no se pudo consultar docker compose\n'
  fi
}

print_vm_status() {
  local vm_name="${JUDGE_VM_NAME:-duelodev-judge-dev}"
  local vm_user="${JUDGE_VM_USER:-judge}"
  local vm_host="${JUDGE_VM_HOST:-127.0.0.1}"
  local vm_port="${JUDGE_VM_PORT:-2222}"
  local remote_dir="${JUDGE_VM_REMOTE_DIR:-/home/judge/duelodev-tournament-worker}"

  if ! command -v VBoxManage >/dev/null 2>&1; then
    printf 'VM juez: no verificable; VBoxManage no está disponible\n'
    return
  fi

  if ! VBoxManage showvminfo "$vm_name" --machinereadable >/dev/null 2>&1; then
    printf 'VM juez: %s no existe\n' "$vm_name"
    return
  fi

  local vm_state
  vm_state="$(VBoxManage showvminfo "$vm_name" --machinereadable | awk -F= '$1 == "VMState" {gsub(/"/, "", $2); print $2}')"
  printf 'VM juez: %s estado=%s\n' "$vm_name" "${vm_state:-desconocido}"

  if [[ "$vm_state" != "running" ]]; then
    return
  fi

  local ssh_cmd=(
    ssh
    -o BatchMode=yes
    -o ConnectTimeout=3
    -o StrictHostKeyChecking=accept-new
    -p "$vm_port"
    "${vm_user}@${vm_host}"
  )

  if ! "${ssh_cmd[@]}" 'true' >/dev/null 2>&1; then
    printf 'Worker juez: no verificable; SSH no respondió en %s:%s\n' "$vm_host" "$vm_port"
    return
  fi

  local worker_status
  worker_status="$("${ssh_cmd[@]}" "if [[ -f '${remote_dir}/worker.pid' ]]; then pid=\$(cat '${remote_dir}/worker.pid'); if [[ \"\$pid\" =~ ^[0-9]+$ ]] && kill -0 \"\$pid\" >/dev/null 2>&1; then printf 'activo pid=%s' \"\$pid\"; else printf 'pid registrado pero proceso inactivo'; fi; else printf 'sin worker.pid'; fi" 2>/dev/null || true)"
  printf 'Worker juez: %s\n' "${worker_status:-no verificable}"
}

load_env_defaults

api_port="${API_PORT:-3001}"
realtime_port="${REALTIME_PORT:-3002}"
web_port="${WEB_PORT:-3000}"
postgres_port="${POSTGRES_PORT:-5433}"
redis_port="${REDIS_PORT:-6380}"
lan_host="$(detect_lan_host)"

printf 'Estado DueloDev torneo LAN\n'
printf 'Repo: %s\n' "$repo_root"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'Git: %s %s\n' "$(git branch --show-current 2>/dev/null || true)" "$(git rev-parse --short HEAD 2>/dev/null || true)"
fi
printf 'URL torneo: %s\n' "${lan_host:+http://${lan_host}:${web_port}}"
printf 'API pública: %s\n' "${lan_host:+http://${lan_host}:${api_port}/api/v1}"
printf 'Realtime público: %s\n' "${lan_host:+ws://${lan_host}:${realtime_port}/match}"

if [[ -n "${AUTH_SECRET:-}" ]]; then
  printf 'AUTH_SECRET: configurado en entorno/.env (valor oculto)\n'
else
  printf 'AUTH_SECRET: no cargado; tournament:start lo generará y persistirá en .env\n'
fi

if [[ -f web/.next/BUILD_ID ]]; then
  printf 'Build web: disponible (%s)\n' "$(cat web/.next/BUILD_ID)"
else
  printf 'Build web: no disponible; ejecuta npm run build antes de usar SKIP_BUILD=1\n'
fi

printf 'Puertos:\n'
print_port_status "$api_port" api
print_port_status "$realtime_port" realtime
print_port_status "$web_port" web
print_port_status "$postgres_port" postgres
print_port_status "$redis_port" redis

print_docker_status
print_vm_status
