#!/usr/bin/env bash
# Crea una VM desechable para validar el sandbox del juez.
# No instala ni ejecuta código enviado por jugadores.

set -euo pipefail

readonly DEFAULT_VM_NAME="duelodev-judge-dev"
readonly IMAGE_NAME="noble-server-cloudimg-amd64.img"
readonly IMAGE_URL="https://cloud-images.ubuntu.com/noble/current/${IMAGE_NAME}"
readonly CHECKSUMS_URL="https://cloud-images.ubuntu.com/noble/current/SHA256SUMS"
readonly GUEST_USER="judge"
readonly SSH_PORT="2222"
readonly DISK_SIZE_MIB="30720"

user_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
vm_name="$DEFAULT_VM_NAME"
vm_base_dir="${user_home}/VirtualBox VMs"
cache_dir="${user_home}/.cache/duelodev-judge"
ssh_public_key="${user_home}/.ssh/id_ed25519.pub"

usage() {
  cat <<'EOF'
Uso: scripts/judge-vm-create.sh [opciones]

Opciones:
  --ssh-public-key RUTA  Clave pública para acceso SSH al invitado.
  --vm-base-dir RUTA     Directorio padre de la VM de VirtualBox.
  --cache-dir RUTA       Directorio externo al repositorio para la imagen oficial.
  --help                 Muestra esta ayuda.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --ssh-public-key)
      ssh_public_key="${2:-}"
      shift 2
      ;;
    --vm-base-dir)
      vm_base_dir="${2:-}"
      shift 2
      ;;
    --cache-dir)
      cache_dir="${2:-}"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      fail "opción no reconocida: $1"
      ;;
  esac
done

for command_name in VBoxManage curl sha256sum qemu-img genisoimage; do
  command -v "$command_name" >/dev/null 2>&1 || fail "falta el comando requerido: $command_name"
done

[[ -r "$ssh_public_key" ]] || fail "no se puede leer la clave pública: $ssh_public_key"
[[ "$(VBoxManage list vms)" != *"\"${vm_name}\""* ]] || fail "la VM ${vm_name} ya existe"
[[ ! -e "${vm_base_dir}/${vm_name}" ]] || fail "ya existe el directorio de la VM: ${vm_base_dir}/${vm_name}"

mkdir -p "$vm_base_dir" "$cache_dir"

image_path="${cache_dir}/${IMAGE_NAME}"
checksums_path="${cache_dir}/SHA256SUMS"
image_part="${image_path}.part"
created_vm=false

cleanup_on_exit() {
  if [[ "$created_vm" == true ]]; then
    VBoxManage unregistervm "$vm_name" --delete >/dev/null 2>&1 || true
  fi
}

trap cleanup_on_exit EXIT

curl --fail --location --retry 3 --output "${checksums_path}.part" "$CHECKSUMS_URL"
mv "${checksums_path}.part" "$checksums_path"
expected_checksum="$(awk -v image="$IMAGE_NAME" '$2 == "*" image { print $1; exit }' "$checksums_path")"
[[ "$expected_checksum" =~ ^[[:xdigit:]]{64}$ ]] || fail "no se encontró el checksum de ${IMAGE_NAME}"

if [[ ! -f "$image_path" ]] || ! printf '%s  %s\n' "$expected_checksum" "$image_path" | sha256sum --check --status; then
  rm -f "$image_part"
  curl --fail --location --retry 3 --output "$image_part" "$IMAGE_URL"
  printf '%s  %s\n' "$expected_checksum" "$image_part" | sha256sum --check --status || fail "checksum inválido de la imagen Ubuntu"
  mv "$image_part" "$image_path"
fi

VBoxManage createvm --name "$vm_name" --ostype Ubuntu_64 --basefolder "$vm_base_dir" --register
created_vm=true

vm_dir="${vm_base_dir}/${vm_name}"
seed_dir="${vm_dir}/cloud-init"
mkdir -p "$seed_dir"
ssh_key="$(tr -d '\r\n' < "$ssh_public_key")"
[[ "$ssh_key" == ssh-* ]] || fail "la clave indicada no parece una clave pública SSH"

cat >"${seed_dir}/meta-data" <<EOF
instance-id: ${vm_name}
local-hostname: ${vm_name}
EOF

cat >"${seed_dir}/user-data" <<EOF
#cloud-config
users:
  - name: ${GUEST_USER}
    groups: [sudo]
    shell: /bin/bash
    lock_passwd: true
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${ssh_key}
ssh_pwauth: false
disable_root: true
package_update: true
package_upgrade: false
EOF

genisoimage -quiet -output "${vm_dir}/seed.iso" -volid cidata -joliet -rock "${seed_dir}/user-data" "${seed_dir}/meta-data"
qemu-img convert -p -O vdi "$image_path" "${vm_dir}/disk.vdi"
VBoxManage modifymedium disk "${vm_dir}/disk.vdi" --resize "$DISK_SIZE_MIB"

VBoxManage modifyvm "$vm_name" \
  --memory 4096 \
  --cpus 4 \
  --ioapic on \
  --boot1 disk \
  --boot2 dvd \
  --boot3 none \
  --nic1 nat \
  --natpf1 "judge-ssh,tcp,127.0.0.1,${SSH_PORT},,22" \
  --clipboard disabled \
  --draganddrop disabled \
  --usb off \
  --audio-driver none
VBoxManage storagectl "$vm_name" --name SATA --add sata --controller IntelAhci --bootable on
VBoxManage storageattach "$vm_name" --storagectl SATA --port 0 --device 0 --type hdd --medium "${vm_dir}/disk.vdi"
VBoxManage storageattach "$vm_name" --storagectl SATA --port 1 --device 0 --type dvddrive --medium "${vm_dir}/seed.iso"
VBoxManage startvm "$vm_name" --type headless
created_vm=false

printf 'VM creada e iniciada: %s\n' "$vm_name"
printf 'Acceso cuando cloud-init termine: ssh -p %s %s@127.0.0.1\n' "$SSH_PORT" "$GUEST_USER"
