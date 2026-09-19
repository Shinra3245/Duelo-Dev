#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
. "${repo_root}/scripts/lib/env.sh"

pids=()
judge_started=false
cleaned_up=false
state_dir="${TOURNAMENT_STATE_DIR:-tmp/tournament}"

cleanup() {
  if [[ "$cleaned_up" == true ]]; then
    return
  fi
  cleaned_up=true
  if [[ "$judge_started" == true ]]; then
    scripts/judge-vm-worker-stop.sh >/dev/null 2>&1 || true
  fi
  if ((${#pids[@]} > 0)); then
    printf '\nDeteniendo servicios Node...\n'
    for pid in "${pids[@]}"; do
      pkill -TERM -P "$pid" >/dev/null 2>&1 || true
      kill -TERM "$pid" >/dev/null 2>&1 || true
    done
    sleep 1
    for pid in "${pids[@]}"; do
      pkill -KILL -P "$pid" >/dev/null 2>&1 || true
      kill -KILL "$pid" >/dev/null 2>&1 || true
    done
  fi
  if [[ -d "$state_dir" ]]; then
    rm -f "$state_dir"/api.pid "$state_dir"/realtime.pid "$state_dir"/web.pid "$state_dir"/judge-started
  fi
}

handle_signal() {
  cleanup
  exit 130
}

trap cleanup EXIT
trap handle_signal INT TERM

env_file_has_key() {
  local key="$1"
  [[ -f .env ]] && grep -Eq "^[[:space:]]*${key}=" .env
}

generate_auth_secret() {
  openssl rand -base64 48 2>/dev/null || node -e 'console.log(crypto.randomUUID()+crypto.randomUUID())'
}

write_auth_secret_to_env() {
  local generated_secret="$1"

  if [[ ! -f .env ]]; then
    umask 077
    : > .env
  fi

  if env_file_has_key AUTH_SECRET; then
    local temp_env
    temp_env="$(mktemp)"
    GENERATED_AUTH_SECRET="$generated_secret" awk '
      BEGIN { written = 0 }
      /^[[:space:]]*AUTH_SECRET=/ {
        if (written == 0) {
          print "AUTH_SECRET=" ENVIRON["GENERATED_AUTH_SECRET"]
          written = 1
        }
        next
      }
      { print }
    ' .env > "$temp_env"
    cat "$temp_env" > .env
    rm -f "$temp_env"
    return
  fi

  if [[ -s .env ]]; then
    local last_byte
    last_byte="$(tail -c 1 .env | od -An -t x1 | tr -d '[:space:]')"
    if [[ "$last_byte" != "0a" ]]; then
      printf '\n' >> .env
    fi
  fi

  {
    printf '\n# Generado por scripts/tournament-start.sh para mantener sesiones tras reinicios.\n'
    printf 'AUTH_SECRET=%s\n' "$generated_secret"
  } >> .env
}

ensure_auth_secret() {
  if [[ -n "${AUTH_SECRET:-}" ]]; then
    return
  fi

  local generated_secret
  generated_secret="$(generate_auth_secret)"
  export AUTH_SECRET="$generated_secret"

  write_auth_secret_to_env "$generated_secret"
  printf 'ok: AUTH_SECRET generado y guardado en .env para reinicios del torneo.\n'
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
    printf 'Aviso: LAN_HOST detectado como %s. Si los alumnos no pueden entrar, reinicia con LAN_HOST=IP_WIFI npm run tournament:start\n' "$detected_host" >&2
  fi
}

wait_http_ready() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 60); do
    if curl --fail --silent --output /dev/null "$url"; then
      printf 'ok: %s listo\n' "$label"
      return
    fi
    sleep 1
  done
  printf 'Error: %s no quedó listo: %s\n' "$label" "$url" >&2
  exit 1
}

ensure_web_build_available() {
  if [[ -f web/.next/BUILD_ID ]]; then
    return
  fi

  printf 'Error: SKIP_BUILD=1 requiere un build previo de web/.next.\n' >&2
  printf 'Ejecuta primero npm run build o reinicia sin SKIP_BUILD=1.\n' >&2
  exit 1
}

require_port_available() {
  local port="$1"
  local label="$2"

  if ! command -v ss >/dev/null 2>&1; then
    printf 'Aviso: no se pudo verificar el puerto %s (%s); falta ss en PATH.\n' "$port" "$label" >&2
    return
  fi

  if ss -H -ltn "sport = :${port}" | grep -q .; then
    printf 'Error: el puerto %s (%s) ya está en uso.\n' "$port" "$label" >&2
    printf 'Detén la instancia anterior o usa %s_PORT=otro_puerto.\n' "${label^^}" >&2
    exit 1
  fi
}

load_env_defaults
mkdir -p "$state_dir"
chmod 700 "$state_dir"

lan_host="$(detect_lan_host)"
if [[ -z "$lan_host" ]]; then
  printf 'Error: no se pudo detectar LAN_HOST. Ejecuta: LAN_HOST=192.168.x.x npm run tournament:start\n' >&2
  exit 1
fi

export NODE_ENV="production"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export POSTGRES_USER="${POSTGRES_USER:-duelodev}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-cambiame_en_local}"
export POSTGRES_DB="${POSTGRES_DB:-duelodev}"
export POSTGRES_PORT="${POSTGRES_PORT:-5433}"
export REDIS_PORT="${REDIS_PORT:-6380}"
export API_PORT="${API_PORT:-3001}"
export API_HOST="${API_HOST:-0.0.0.0}"
export REALTIME_PORT="${REALTIME_PORT:-3002}"
export REALTIME_HOST="${REALTIME_HOST:-0.0.0.0}"
export WEB_PORT="${WEB_PORT:-3000}"
export DATABASE_URL="${DATABASE_URL:-postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}}"
export REDIS_URL="${REDIS_URL:-redis://localhost:${REDIS_PORT}}"
export EPHEMERAL_GUEST_SESSIONS="${EPHEMERAL_GUEST_SESSIONS:-1}"
ensure_auth_secret
export NEXT_PUBLIC_API_URL="http://${lan_host}:${API_PORT}/api/v1"
export NEXT_PUBLIC_REALTIME_URL="ws://${lan_host}:${REALTIME_PORT}/match"
export CORS_ORIGINS="${TOURNAMENT_CORS_ORIGINS:-http://${lan_host}:${WEB_PORT}}"
if [[ ",${CORS_ORIGINS}," == *",*"* ]]; then
  printf 'Error: CORS_ORIGINS no puede contener * cuando las sesiones usan cookies.\n' >&2
  exit 1
fi

printf 'Iniciando DueloDev para torneo LAN\n'
printf 'Web:      http://%s:%s\n' "$lan_host" "$WEB_PORT"
printf 'API:      %s\n' "$NEXT_PUBLIC_API_URL"
printf 'Realtime: %s\n' "$NEXT_PUBLIC_REALTIME_URL"
warn_if_suspicious_lan_host "$lan_host"

require_port_available "$API_PORT" api
require_port_available "$REALTIME_PORT" realtime
require_port_available "$WEB_PORT" web

if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
  ensure_web_build_available
fi

scripts/tournament-preflight.sh

docker compose up -d --wait
if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
  printf 'Aviso: SKIP_BUILD=1 activo; se usará el último build disponible.\n'
else
  npm run build
fi

npm run start --workspace @duelodev/api &
pids+=("$!")
printf '%s\n' "$!" > "$state_dir/api.pid"
wait_http_ready "http://127.0.0.1:${API_PORT}/readyz" api

npm run start --workspace @duelodev/realtime &
pids+=("$!")
printf '%s\n' "$!" > "$state_dir/realtime.pid"
wait_http_ready "http://127.0.0.1:${REALTIME_PORT}/readyz" realtime

if [[ "${START_JUDGE_VM:-0}" == "1" || "${REQUIRE_JUDGE_VM:-0}" == "1" ]]; then
  if scripts/judge-vm-worker-start.sh; then
    judge_started=true
    : > "$state_dir/judge-started"
  elif [[ "${REQUIRE_JUDGE_VM:-0}" == "1" ]]; then
    printf 'Error: el worker del juez no pudo iniciar y REQUIRE_JUDGE_VM=1.\n' >&2
    exit 1
  else
    printf 'Aviso: el worker del juez no inició; los envíos quedarán pendientes hasta arrancarlo.\n' >&2
  fi
fi

npm run start --workspace @duelodev/web -- -H 0.0.0.0 -p "$WEB_PORT" &
pids+=("$!")
printf '%s\n' "$!" > "$state_dir/web.pid"

printf '\nTorneo listo en http://%s:%s\n' "$lan_host" "$WEB_PORT"
printf 'Presiona Ctrl+C para detener API, realtime, web y el worker iniciado por este script.\n'

wait "${pids[@]}"
