#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

state_dir="${TOURNAMENT_STATE_DIR:-tmp/tournament}"

stop_pid_file() {
  local pid_file="$1"
  local label="$2"

  if [[ ! -f "$pid_file" ]]; then
    printf 'sin pid registrado para %s\n' "$label"
    return
  fi

  local pid
  pid="$(cat "$pid_file")"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    printf 'pid inválido para %s: %s\n' "$label" "$pid" >&2
    rm -f "$pid_file"
    return
  fi

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    printf '%s no está activo; limpiando pid %s\n' "$label" "$pid"
    rm -f "$pid_file"
    return
  fi

  printf 'deteniendo %s pid=%s\n' "$label" "$pid"
  pkill -TERM -P "$pid" >/dev/null 2>&1 || true
  kill -TERM "$pid" >/dev/null 2>&1 || true

  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$pid_file"
      return
    fi
    sleep 0.25
  done

  printf 'forzando cierre de %s pid=%s\n' "$label" "$pid"
  pkill -KILL -P "$pid" >/dev/null 2>&1 || true
  kill -KILL "$pid" >/dev/null 2>&1 || true
  rm -f "$pid_file"
}

printf 'Deteniendo servicios de torneo registrados en %s\n' "$state_dir"

stop_pid_file "$state_dir/web.pid" web
stop_pid_file "$state_dir/realtime.pid" realtime
stop_pid_file "$state_dir/api.pid" api

if [[ -f "$state_dir/judge-started" || "${STOP_JUDGE_VM:-0}" == "1" ]]; then
  printf 'deteniendo worker del juez en VM\n'
  scripts/judge-vm-worker-stop.sh >/dev/null 2>&1 || true
  rm -f "$state_dir/judge-started"
else
  printf 'worker del juez no fue iniciado por el último tournament:start registrado\n'
fi

printf 'tournament:stop finalizado\n'
