#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

failures=0

load_env_defaults() {
  [[ -f .env ]] || return
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
check_command() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    printf 'ok: %s\n' "$name"
  else
    printf 'falta: %s\n' "$name" >&2
    failures=$((failures + 1))
  fi
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

warn_if_suspicious_lan_host() {
  local detected_host="$1"
  if [[ -n "${LAN_HOST:-}" ]]; then
    return
  fi

  if [[ "$detected_host" == 10.0.2.* || "$detected_host" == 172.1[6-9].* || "$detected_host" == 172.2[0-9].* || "$detected_host" == 172.3[0-1].* ]]; then
    printf 'aviso: LAN_HOST parece una IP de VM/NAT (%s); si otros equipos no abren la web, usa LAN_HOST=IP_WIFI\n' "$detected_host"
  fi
}

check_port() {
  local port="$1"
  local label="$2"
  if command -v ss >/dev/null 2>&1 && ss -H -ltn "sport = :${port}" | grep -q .; then
    printf 'aviso: puerto %s (%s) ya está en uso\n' "$port" "$label"
  else
    printf 'ok: puerto %s (%s) disponible o no detectable\n' "$port" "$label"
  fi
}

load_env_defaults

printf 'Preflight DueloDev torneo LAN\n'

for command_name in node npm docker curl; do
  check_command "$command_name"
done

if docker compose version >/dev/null 2>&1; then
  printf 'ok: docker compose\n'
else
  printf 'falta: docker compose\n' >&2
  failures=$((failures + 1))
fi

if [[ -f package-lock.json ]]; then
  printf 'ok: package-lock.json\n'
else
  printf 'falta: package-lock.json\n' >&2
  failures=$((failures + 1))
fi

lan_host="$(detect_lan_host)"
if [[ -z "$lan_host" ]]; then
  printf 'falta: no se pudo detectar LAN_HOST; ejecútalo con LAN_HOST=IP_DEL_EQUIPO\n' >&2
  failures=$((failures + 1))
else
  printf 'ok: LAN_HOST=%s\n' "$lan_host"
  warn_if_suspicious_lan_host "$lan_host"
fi

api_port="${API_PORT:-3001}"
realtime_port="${REALTIME_PORT:-3002}"
web_port="${WEB_PORT:-3000}"
postgres_port="${POSTGRES_PORT:-5433}"
redis_port="${REDIS_PORT:-6380}"

check_port "$api_port" api
check_port "$realtime_port" realtime
check_port "$web_port" web
check_port "$postgres_port" postgres
check_port "$redis_port" redis

if docker compose config >/dev/null; then
  printf 'ok: docker-compose.yml válido\n'
else
  printf 'falla: docker-compose.yml no es válido\n' >&2
  failures=$((failures + 1))
fi

if command -v VBoxManage >/dev/null 2>&1; then
  if VBoxManage showvminfo duelodev-judge-dev --machinereadable >/dev/null 2>&1; then
    vm_state="$(VBoxManage showvminfo duelodev-judge-dev --machinereadable | awk -F= '$1 == "VMState" {gsub(/"/, "", $2); print $2}')"
    printf 'ok: VM duelodev-judge-dev existe, estado=%s\n' "$vm_state"
  else
    printf 'aviso: no existe la VM duelodev-judge-dev; el juez real requiere crear/provisionar la VM\n'
  fi
else
  printf 'aviso: VBoxManage no está en PATH; no se pudo verificar la VM del juez\n'
fi

if [[ -n "$lan_host" ]]; then
  printf 'URL torneo: http://%s:%s\n' "$lan_host" "$web_port"
  printf 'API pública: http://%s:%s/api/v1\n' "$lan_host" "$api_port"
  printf 'Realtime público: ws://%s:%s/match\n' "$lan_host" "$realtime_port"
fi

if ((failures > 0)); then
  printf 'Preflight falló con %s problema(s).\n' "$failures" >&2
  exit 1
fi

printf 'Preflight completado.\n'
