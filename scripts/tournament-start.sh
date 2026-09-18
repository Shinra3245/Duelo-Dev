#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

pids=()
judge_started=false

cleanup() {
  if [[ "$judge_started" == true ]]; then
    scripts/judge-vm-worker-stop.sh >/dev/null 2>&1 || true
  fi
  if ((${#pids[@]} > 0)); then
    printf '\nDeteniendo servicios Node...\n'
    kill "${pids[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

load_env_file() {
  if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
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

load_env_file

lan_host="$(detect_lan_host)"
if [[ -z "$lan_host" ]]; then
  printf 'Error: no se pudo detectar LAN_HOST. Ejecuta: LAN_HOST=192.168.x.x npm run tournament:start\n' >&2
  exit 1
fi

export NODE_ENV="${NODE_ENV:-production}"
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
export AUTH_SECRET="${AUTH_SECRET:-$(openssl rand -base64 48 2>/dev/null || node -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://${lan_host}:${API_PORT}/api/v1}"
export NEXT_PUBLIC_REALTIME_URL="${NEXT_PUBLIC_REALTIME_URL:-ws://${lan_host}:${REALTIME_PORT}/match}"
export CORS_ORIGINS="${CORS_ORIGINS:-http://${lan_host}:${WEB_PORT},http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}}"

printf 'Iniciando DueloDev para torneo LAN\n'
printf 'Web:      http://%s:%s\n' "$lan_host" "$WEB_PORT"
printf 'API:      %s\n' "$NEXT_PUBLIC_API_URL"
printf 'Realtime: %s\n' "$NEXT_PUBLIC_REALTIME_URL"

scripts/tournament-preflight.sh

docker compose up -d --wait
npm run build

npm run start --workspace @duelodev/api &
pids+=("$!")
wait_http_ready "http://127.0.0.1:${API_PORT}/readyz" api

npm run start --workspace @duelodev/realtime &
pids+=("$!")
wait_http_ready "http://127.0.0.1:${REALTIME_PORT}/readyz" realtime

if [[ "${START_JUDGE_VM:-auto}" != "0" ]]; then
  if scripts/judge-vm-worker-start.sh; then
    judge_started=true
  elif [[ "${REQUIRE_JUDGE_VM:-0}" == "1" ]]; then
    printf 'Error: el worker del juez no pudo iniciar y REQUIRE_JUDGE_VM=1.\n' >&2
    exit 1
  else
    printf 'Aviso: el worker del juez no inició; los envíos quedarán pendientes hasta arrancarlo.\n' >&2
  fi
fi

npm run start --workspace @duelodev/web -- -H 0.0.0.0 -p "$WEB_PORT" &
pids+=("$!")

printf '\nTorneo listo en http://%s:%s\n' "$lan_host" "$WEB_PORT"
printf 'Presiona Ctrl+C para detener API, realtime, web y el worker iniciado por este script.\n'

wait "${pids[@]}"
