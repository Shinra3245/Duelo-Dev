#!/usr/bin/env bash
set -euo pipefail

pids=()

cleanup() {
  if [ ${#pids[@]} -gt 0 ]; then
    echo
    echo "Deteniendo servicios Node..."
    kill "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "Iniciando dependencias en Docker (PostgreSQL, Redis)..."
docker compose up -d --wait

echo "Compilando paquetes compartidos y servicios..."
npm run build

export DATABASE_URL="${DATABASE_URL:-postgres://duelodev:cambiame_en_local@localhost:5433/duelodev}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6380}"
export AUTH_SECRET="${AUTH_SECRET:-secreto_local_desarrollo_cambia_antes_de_produccion}"
export API_PORT="${API_PORT:-3001}"
export API_HOST="${API_HOST:-0.0.0.0}"
export REALTIME_PORT="${REALTIME_PORT:-3002}"
export REALTIME_HOST="${REALTIME_HOST:-0.0.0.0}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://localhost:3001/api/v1}"
export NEXT_PUBLIC_REALTIME_URL="${NEXT_PUBLIC_REALTIME_URL:-ws://localhost:3002/match}"

echo "Iniciando API (${API_PORT}), Realtime (${REALTIME_PORT}) y Web (3000)..."
echo "Presiona Ctrl+C para detener."

npm run start --workspace @duelodev/api &
pids+=("$!")

npm run start --workspace @duelodev/realtime &
pids+=("$!")

npm run dev --workspace @duelodev/web &
pids+=("$!")

wait "${pids[@]}"
