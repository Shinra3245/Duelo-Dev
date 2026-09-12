#!/usr/bin/env bash
# Elimina únicamente la VM desechable creada por judge-vm-create.sh.

set -euo pipefail

readonly VM_NAME="duelodev-judge-dev"

command -v VBoxManage >/dev/null 2>&1 || {
  printf 'Error: falta VBoxManage\n' >&2
  exit 1
}

if [[ "$(VBoxManage list vms)" != *"\"${VM_NAME}\""* ]]; then
  printf 'La VM %s no existe; no hay nada que eliminar.\n' "$VM_NAME"
  exit 0
fi

VBoxManage controlvm "$VM_NAME" poweroff 2>/dev/null || true
VBoxManage unregistervm "$VM_NAME" --delete
printf 'VM eliminada: %s\n' "$VM_NAME"
