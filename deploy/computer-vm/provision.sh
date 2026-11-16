#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
[[ ! -f $VM/provisioned ]] || { echo "$OMB_VM_NAME is already provisioned"; exit 0; }
[[ -z ${OMB_VM_BROWSER_PROXY:-} || ${OMB_VM_BROWSER_PROXY:-} =~ ^[A-Za-z0-9.-]+:[0-9]+$ ]] || { echo "OMB_VM_BROWSER_PROXY must be host:port" >&2; exit 1; }
[[ -z ${OMB_VM_GUEST_PROXY:-} || ${OMB_VM_GUEST_PROXY:-} =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] || { echo "OMB_VM_GUEST_PROXY must be http://host:port" >&2; exit 1; }
wait_for_guest
umask 077
secret() { [[ -s $SECRETS/$1 ]] || python3 -c 'import secrets, sys; print(secrets.token_urlsafe(int(sys.argv[1])))' "$2" > "$SECRETS/$1"; }
secret browser-proxy.token 36
secret console-owner-password.txt 18
secret vm-user-password.txt 18
SRC="$CACHE/omarchy-server-$(pin omarchyServer.commit)"
tar_flags=()
if tar --version 2>/dev/null | grep -q bsdtar; then tar_flags=(--no-xattrs --no-mac-metadata); fi
guest 'rm -rf /tmp/omb-provision && mkdir -m 700 /tmp/omb-provision'
COPYFILE_DISABLE=1 tar -C "$SRC" ${tar_flags[@]+"${tar_flags[@]}"} --exclude './.git/hooks' -cf - . |
  guest 'mkdir /tmp/omb-provision/omarchy-server-src && tar -C /tmp/omb-provision/omarchy-server-src -xf - 2>/dev/null'
guest_copy "$CACHE/browseros-neo-$(pin browserosNeo.version)-x86_64.AppImage" "$GUEST_USER@127.0.0.1:/tmp/omb-provision/browseros-neo.AppImage"
guest_copy "$RECIPE/guest/provision-guest.sh" "$RECIPE/guest/omb-browser-proxy.mjs" "$RECIPE/guest/omb-browser.pac" "$RECIPE/guest/omb-browser.service" \
  "$RECIPE/guest/omb-browser-view" \
  "$RECIPE/guest/omb-browser-proxy.service" "$SECRETS/browser-proxy.token" "$SECRETS/console-owner-password.txt" \
  "$SECRETS/vm-user-password.txt" "$GUEST_USER@127.0.0.1:/tmp/omb-provision/"
proxy_env=""
if [[ -n ${OMB_VM_GUEST_PROXY:-} ]]; then
  proxy_env="http_proxy=$OMB_VM_GUEST_PROXY https_proxy=$OMB_VM_GUEST_PROXY HTTP_PROXY=$OMB_VM_GUEST_PROXY HTTPS_PROXY=$OMB_VM_GUEST_PROXY no_proxy=localhost,127.0.0.1,::1 NO_PROXY=localhost,127.0.0.1,::1"
fi
if ! guest "env $proxy_env OMB_OMARCHY_SERVER_COMMIT=$(pin omarchyServer.commit) OMB_OMARCHY_SERVER_HELPER_SHA256=$(pin omarchyServer.helperSha256) OMB_NEO_SHA256=$(pin browserosNeo.x86_64.sha256) OMB_BROWSER_PROXY='${OMB_VM_BROWSER_PROXY:-}' OMB_VM_HOST_ADDRESS=$VM_HOST_ADDRESS bash /tmp/omb-provision/provision-guest.sh"; then
  echo "Provisioning failed. $OMB_VM_NAME is not ready: fix the cause and run provision.sh again, or stop.sh the VM." >&2
  exit 1
fi
date -u +%FT%TZ > "$VM/provisioned"
echo "PROVISIONED $OMB_VM_NAME: browser proxy http://127.0.0.1:$PROXY_PORT (token in $SECRETS/browser-proxy.token), console http://127.0.0.1:$CONSOLE_PORT, screen 127.0.0.1:$SCREEN_PORT"
