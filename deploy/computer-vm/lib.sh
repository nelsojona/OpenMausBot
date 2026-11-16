# Shared paths and SSH helpers for the BrowserOS neo VM recipe.
RECIPE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PIN="$RECIPE/image-pin.json"
OMB_VM_HOME=${OMB_VM_HOME:-$HOME/.openmausbot-vm}
OMB_VM_NAME=${OMB_VM_NAME:-default}
CACHE="$OMB_VM_HOME/cache"
VM="$OMB_VM_HOME/vms/$OMB_VM_NAME"
SECRETS="$VM/secrets"
RUN="$VM/run"
SSH_PORT=${OMB_VM_SSH_PORT:-2322}
PROXY_PORT=${OMB_VM_BROWSER_PROXY_PORT:-7781}
CONSOLE_PORT=${OMB_VM_CONSOLE_PORT:-7780}
SCREEN_PORT=${OMB_VM_SCREEN_PORT:-5981}
GUEST_USER=omarchy
GUEST_PROXY_PORT=7791
# QEMU user networking exposes the host loopback to the guest at 10.0.2.2.
VM_HOST_ADDRESS=10.0.2.2

pin() { python3 -c 'import json,sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value[key]
print(value)' "$PIN" "$1"; }

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d" " -f1; else shasum -a 256 "$1" | cut -d" " -f1; fi; }

guest() {
  ssh -i "$SECRETS/id_ed25519" -p "$SSH_PORT" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR \
    "$GUEST_USER@127.0.0.1" "$@"
}

wait_for_guest() {
  for _ in $(seq 1 150); do guest true 2>/dev/null && return 0; sleep 2; done
  echo "the VM does not answer over SSH" >&2
  return 1
}

guest_copy() {
  scp -q -i "$SECRETS/id_ed25519" -P "$SSH_PORT" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$@"
}
