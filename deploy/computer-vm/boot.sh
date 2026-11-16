#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
QEMU=${OMB_VM_QEMU:-qemu-system-x86_64}
QEMU_IMG=${OMB_VM_QEMU_IMG:-qemu-img}
version=$(pin omarchy.version)
mkdir -p "$RUN" "$SECRETS"; chmod 700 "$RUN" "$SECRETS"
[[ $SECRETS != *,* ]] || { echo "OMB_VM_HOME cannot contain a comma" >&2; exit 1; }
for f in qcow2 vmlinuz initrd cmdline; do [[ -s $CACHE/omarchy-$version.$f ]] || { echo "run fetch.sh first" >&2; exit 1; }; done
if [[ -f $RUN/qemu.pid ]] && kill -0 "$(cat "$RUN/qemu.pid")" 2>/dev/null; then echo "already running (pid $(cat "$RUN/qemu.pid"))" >&2; exit 1; fi
[[ -f $SECRETS/id_ed25519 ]] || ssh-keygen -q -t ed25519 -N "" -C "openmausbot-vm-$OMB_VM_NAME" -f "$SECRETS/id_ed25519"
[[ -f $VM/disk.qcow2 ]] || "$QEMU_IMG" create -q -f qcow2 -b "$CACHE/omarchy-$version.qcow2" -F qcow2 "$VM/disk.qcow2"
[[ -f $VM/uuid ]] || (uuidgen | tr 'A-Z' 'a-z' > "$VM/uuid")
(( SCREEN_PORT >= 5900 && SCREEN_PORT <= 5999 )) || { echo "OMB_VM_SCREEN_PORT must be 5900 to 5999" >&2; exit 1; }
[[ -s $SECRETS/screen-password.txt ]] || (umask 077; python3 -c 'import secrets, string; print("".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8)), end="")' > "$SECRETS/screen-password.txt")
bash "$RECIPE/credential.sh" > "$RUN/tmpfiles.extra"
rm -f "$RUN/qmp.sock" "$RUN/vnc.sock" "$RUN/qemu.pid"
if [[ -r /dev/kvm && -w /dev/kvm ]]; then accel=(-enable-kvm -cpu host); else accel=(-accel "tcg,thread=multi,tb-size=2048" -cpu max); fi
net="user,id=n0,ipv6=off,hostfwd=tcp:127.0.0.1:$SSH_PORT-:22,hostfwd=tcp:127.0.0.1:$PROXY_PORT-:$GUEST_PROXY_PORT,hostfwd=tcp:127.0.0.1:$CONSOLE_PORT-:7780"
if [[ ${OMB_VM_EGRESS_RELAY:-} == *,* ]]; then echo "OMB_VM_EGRESS_RELAY cannot contain a comma" >&2; exit 1; fi
if [[ -n ${OMB_VM_EGRESS_RELAY:-} ]]; then net="$net,restrict=on,guestfwd=tcp:10.0.2.100:3128-cmd:$OMB_VM_EGRESS_RELAY"; fi
date -u +%FT%TZ > "$RUN/boot-started.txt"
"$QEMU" -machine q35 "${accel[@]}" -smp "${OMB_VM_SMP:-4}" -m "${OMB_VM_MEM:-6G}" \
  -kernel "$CACHE/omarchy-$version.vmlinuz" -initrd "$CACHE/omarchy-$version.initrd" \
  -append "$(cat "$CACHE/omarchy-$version.cmdline")${OMB_VM_APPEND:+ $OMB_VM_APPEND}" \
  -uuid "$(cat "$VM/uuid")" \
  -drive "file=$VM/disk.qcow2,format=qcow2,if=none,id=d0" -device virtio-blk-pci,drive=d0 \
  -smbios "type=11,value=io.systemd.credential.binary:tmpfiles.extra=$(base64 < "$RUN/tmpfiles.extra" | tr -d '\n')" \
  -device virtio-vga -device virtio-rng-pci -device qemu-xhci -device usb-kbd -device usb-tablet \
  -netdev "$net" -device virtio-net-pci,netdev=n0 \
  -serial "file:$RUN/serial.log" -display none -vnc "unix:$RUN/vnc.sock" \
  -object "secret,id=screen0,file=$SECRETS/screen-password.txt" \
  -vnc "127.0.0.1:$((SCREEN_PORT - 5900)),password-secret=screen0" \
  -qmp "unix:$RUN/qmp.sock,server,nowait" -pidfile "$RUN/qemu.pid" -daemonize
echo "booted $OMB_VM_NAME (pid $(cat "$RUN/qemu.pid")): ssh 127.0.0.1:$SSH_PORT, browser proxy 127.0.0.1:$PROXY_PORT, console 127.0.0.1:$CONSOLE_PORT, screen 127.0.0.1:$SCREEN_PORT"
