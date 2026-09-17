#!/usr/bin/env bash
set -e

echo "Iniciando dependencias en Docker (PostgreSQL, Redis)..."
npm run up

echo "Compilando paquetes compartidos y servicios..."
npm run build

echo "Iniciando API (3001), Realtime (3002) y Web (3000)..."
echo "Presiona Ctrl+C para detener."

# Export variables locales por defecto si no existen
export DATABASE_URL=${DATABASE_URL:-"postgres://duelodev:cambiame_en_local@localhost:5433/duelodev"}
export REDIS_URL=${REDIS_URL:-"redis://localhost:6380"}
export AUTH_SECRET=${AUTH_SECRET:-"secreto_local_desarrollo"}

npm run start --workspace @duelodev/api &
API_PID=$!

npm run start --workspace @duelodev/realtime &
REALTIME_PID=$!

npm run dev --workspace @duelodev/web &
WEB_PID=$!

trap "echo -e '\nDeteniendo Node...'; kill $API_PID $REALTIME_PID $WEB_PID 2>/dev/null; exit 0" SIGINT SIGTERM

wait $API_PID $REALTIME_PID $WEB_PID
