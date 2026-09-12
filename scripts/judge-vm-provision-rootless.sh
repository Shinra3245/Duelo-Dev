#!/usr/bin/env bash
# Instala Docker rootless exclusivamente dentro de duelodev-judge-dev.
# Requiere que judge-vm-create.sh haya creado la VM y que SSH esté disponible.

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

if [[ "$(id -un)" != "judge" ]]; then
  printf 'Error: el aprovisionamiento debe ejecutarse como judge\n' >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install --yes ca-certificates curl dbus-user-session uidmap
sudo install --directory --mode 0755 /etc/apt/keyrings
sudo curl --fail --location --silent --show-error \
  https://download.docker.com/linux/ubuntu/gpg \
  --output /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

architecture="$(dpkg --print-architecture)"
codename="$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")"
printf '%s\n' \
  "deb [arch=${architecture} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt-get update
sudo apt-get install --yes docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras
sudo systemctl disable --now docker.service docker.socket containerd.service 2>/dev/null || true
sudo rm -f /run/docker.sock

if ! grep -q '^judge:' /etc/subuid; then
  printf 'judge:100000:65536\n' | sudo tee -a /etc/subuid >/dev/null
fi
if ! grep -q '^judge:' /etc/subgid; then
  printf 'judge:100000:65536\n' | sudo tee -a /etc/subgid >/dev/null
fi

sudo loginctl enable-linger judge
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker
export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"

docker info --format 'cgroup_driver={{.CgroupDriver}} cgroup_version={{.CgroupVersion}}'
docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' | grep -qx 'name=rootless'
REMOTE_SCRIPT
