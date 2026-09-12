#!/usr/bin/env bash
# Verifica el daemon rootless y límites efectivos en duelodev-judge-dev.
# El contenedor ejecuta solo comprobaciones controladas, no código de jugadores.

set -euo pipefail

readonly VM_USER="judge"
readonly VM_HOST="127.0.0.1"
readonly VM_PORT="2222"

ssh -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=accept-new \
  -p "$VM_PORT" \
  "${VM_USER}@${VM_HOST}" 'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"

systemctl --user is-active --quiet docker.service || fail 'docker rootless no está activo'
docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' | grep -qx 'name=rootless' \
  || fail 'docker no informa modo rootless'
for service_name in docker.service docker.socket containerd.service; do
  if sudo systemctl is-active --quiet "$service_name"; then
    fail "el servicio rootful sigue activo: ${service_name}"
  fi
done
[[ ! -S /var/run/docker.sock ]] || fail 'existe un socket Docker rootful'

docker run --pull always --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777 \
  --cpus 1 \
  --memory 256m \
  --memory-swap 256m \
  --pids-limit 64 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 65532:65532 \
  alpine:3.20 \
  sh -ec '
    test "$(id -u)" = 65532
    test "$(cat /sys/fs/cgroup/memory.max)" = 268435456
    test "$(cat /sys/fs/cgroup/pids.max)" = 64
    set -- $(cat /sys/fs/cgroup/cpu.max)
    test "$1" = 100000
    test "$2" = 100000
    test ! -S /run/docker.sock
    ! touch /write-must-fail
  '

printf 'Rootless y límites CPU/RAM/PIDs verificados dentro de la VM.\n'
REMOTE_SCRIPT
