#!/usr/bin/env bash
# Elimina únicamente la VM desechable creada por judge-vm-create.sh.

set -euo pipefail

readonly VM_NAME="duelodev-judge-dev"

user_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
vm_dir="${user_home}/VirtualBox VMs/${VM_NAME}"

command -v VBoxManage >/dev/null 2>&1 || {
  printf 'Error: falta VBoxManage\n' >&2
  exit 1
}

if [[ "$(VBoxManage list vms)" == *"\"${VM_NAME}\""* ]]; then
  VBoxManage controlvm "$VM_NAME" poweroff 2>/dev/null || true
  VBoxManage unregistervm "$VM_NAME" --delete
fi

if [[ -d "$vm_dir" ]]; then
  find "$vm_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  rmdir "$vm_dir"
fi

printf 'VM eliminada: %s\n' "$VM_NAME"
