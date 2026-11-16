#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
url=${OMB_VM_VERIFY_URL:-https://example.com}
check() { printf '%-58s %s\n' "$1" "$2"; }
[[ -f $RUN/qemu.pid ]] && kill -0 "$(cat "$RUN/qemu.pid")" 2>/dev/null || { echo "FAIL: $OMB_VM_NAME is not running; boot.sh starts it" >&2; exit 1; }
wait_for_guest
required="omarchyd omarchy-server-web omb-browser omb-browser-proxy"
services() { guest 'for u in omarchyd omarchy-server-web omarchy-server-desktop omb-browser omb-browser-proxy; do printf "%s=%s " $u "$(systemctl --user is-active $u 2>/dev/null)"; done'; }
state=""
for _ in $(seq 1 60); do
  state=$(services || true)
  pending=""
  for unit in $required; do [[ $state == *"$unit=active "* ]] || pending=$unit; done
  [[ -n $pending ]] || break
  sleep 3
done
check "services" "$state"
for unit in $required; do [[ $state == *"$unit=active "* ]] || { echo "FAIL: $unit is not active" >&2; exit 1; }; done
installed=$(guest 'git -C ~/.local/share/omarchy-server/app rev-parse HEAD; sha256sum /usr/local/libexec/omarchy-server/helper.mjs | cut -d" " -f1; sha256sum /opt/browseros-neo/BrowserOS_neo.AppImage | cut -d" " -f1' | tr '\n' ' ')
check "pins (omarchy-server commit, helper, browser)" "$installed"
[[ $installed == "$(pin omarchyServer.commit) $(pin omarchyServer.helperSha256) $(pin browserosNeo.x86_64.sha256) " ]] || { echo "FAIL: an installed artefact does not match image-pin.json" >&2; exit 1; }
sudoers=$(guest 'sudo -n true 2>/dev/null && echo "passwordless sudo STILL ON" || echo "no passwordless sudo"')
check "provisioning sudo rule" "$sudoers"
[[ $sudoers == "no passwordless sudo" ]] || { echo "FAIL: the provisioning sudo rule is still in place" >&2; exit 1; }
idle=$(guest 'jq -c .idle ~/.config/omarchy/shell.json 2>/dev/null; test -e ~/.local/state/omarchy/indicators/stay-awake && echo stay-awake' | tr '\n' ' ')
check "desktop idle actions (0 is off)" "$idle"
[[ $idle == '{"screensaver":0,"lock":0} stay-awake ' ]] || { echo "FAIL: the desktop can still lock or blank" >&2; exit 1; }
firewall=$(guest "sudo -S -p '' ufw status verbose" < "$SECRETS/vm-user-password.txt" 2>&1 | sed 's/  */ /g') || { echo "FAIL: the guest firewall cannot be read with the VM user's password: $(printf '%s' "$firewall" | head -c 300)" >&2; exit 1; }
check "guest firewall" "$(printf '%s\n' "$firewall" | grep -E '^Status|^Default|DENY OUT|ALLOW IN [0-9]' | tr '\n' ';' | cut -c1-330)"
for line in "Status: active" "Default: deny (incoming)" "7791/tcp ALLOW IN $VM_HOST_ADDRESS" "7780/tcp ALLOW IN $VM_HOST_ADDRESS" "$VM_HOST_ADDRESS DENY OUT Anywhere" "169.254.0.0/16 DENY OUT Anywhere"; do
  [[ $firewall == *"$line"* ]] || { echo "FAIL: the guest firewall lacks: $line" >&2; exit 1; }
done
for open in "7791/tcp ALLOW IN Anywhere" "7780/tcp ALLOW IN Anywhere" "7791/tcp (v6) ALLOW IN" "7780/tcp (v6) ALLOW IN"; do
  [[ $firewall != *"$open"* ]] || { echo "FAIL: the guest firewall is open to every source: $open" >&2; exit 1; }
done
ssh_passwords=$(guest 'grep -h -i "^PasswordAuthentication" /etc/ssh/sshd_config.d/*.conf | head -1')
check "SSH passwords" "$ssh_passwords"
[[ $ssh_passwords == "PasswordAuthentication no" ]] || { echo "FAIL: SSH accepts passwords" >&2; exit 1; }
for _ in $(seq 1 30); do [[ $(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PROXY_PORT/healthz" || true) == 200 ]] && break; sleep 2; done
unauthenticated=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/v1/page-browser" -d '{}' || true)
check "proxy without a token" "$unauthenticated"
[[ $unauthenticated == 401 ]] || { echo "FAIL: the proxy answers without a token" >&2; exit 1; }
screen_auth=$(python3 -c 'import socket, sys
try:
    s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), 5)
    s.recv(12)
    s.sendall(b"RFB 003.008\n")
    print(",".join(str(kind) for kind in s.recv(s.recv(1)[0])))
except Exception:
    print("unreachable")' "$SCREEN_PORT")
check "screen port asks for (2 is a password)" "$screen_auth"
[[ $screen_auth == 2 ]] || { echo "FAIL: the VM screen port does not ask for a password, or is not there" >&2; exit 1; }
local_refused=$(curl -s -m 20 -X POST "http://127.0.0.1:$PROXY_PORT/v1/page-browser" -H "authorization: Bearer $(cat "$SECRETS/browser-proxy.token")" -H 'content-type: application/json' -H 'x-omb-browser-session: verify' -d '{"command":"navigate","url":"http://127.0.0.1:7780/"}' || true)
check "local address through the browser" "$(printf '%s' "$local_refused" | cut -c1-120)"
[[ $local_refused == *'"ok":false'* ]] || { echo "FAIL: the browser opens the VM's own services" >&2; exit 1; }
call() { curl -s -m 60 -X POST "http://127.0.0.1:$PROXY_PORT/v1/page-browser" -H "authorization: Bearer $(cat "$SECRETS/browser-proxy.token")" -H 'content-type: application/json' -H 'x-omb-browser-session: verify' -d "$1" || true; }
navigated=""
for _ in $(seq 1 40); do
  navigated=$(call "{\"command\":\"navigate\",\"url\":\"$url\"}")
  [[ $navigated == *'The browser is unavailable'* || $navigated == *'did not answer in time'* ]] || break
  sleep 3
done
check "navigate $url" "$(printf '%s' "$navigated" | cut -c1-120)"
[[ $navigated == *'"ok":true'* ]] || { echo "FAIL: the browser did not open $url" >&2; exit 1; }
snapshot=$(call '{"command":"snapshot"}')
check "snapshot" "$(printf '%s' "$snapshot" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok=%s title=%r elements=%d tree=%d chars" % (d.get("ok"), d.get("title"), len(d.get("elements", [])), len(d.get("tree", ""))))')"
[[ $snapshot == *'"ok":true'* ]] || { echo "FAIL: the browser returned no snapshot" >&2; exit 1; }
front=$(guest 'python3 -' <<'PY' || true
import json, urllib.request
def post(body, session=None):
    headers = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
    if session: headers["mcp-session-id"] = session
    request = urllib.request.Request("http://127.0.0.1:9010/mcp", data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read().decode()
        found = [json.loads(line[5:]) for line in raw.splitlines() if line.startswith("data:") and line[5:].strip().startswith("{")]
        return response.headers.get("mcp-session-id"), (found[-1] if found else json.loads(raw) if raw.strip().startswith("{") else {})
session, _ = post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "omb-verify", "version": "1"}}})
post({"jsonrpc": "2.0", "method": "notifications/initialized"}, session)
_, answer = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "tabs", "arguments": {"action": "active"}}}, session)
print(next((part.get("text", "") for part in answer.get("result", {}).get("content", []) if part.get("type") == "text"), "").splitlines()[0][:150])
PY
)
check "the browser's visible tab" "$front"
[[ $front == "Active page: ["*"] $url"* || $front == "Active page: ["*"] ${url%/}/"* ]] || { echo "FAIL: the page a bot opened is not the browser's visible tab" >&2; exit 1; }
closed_port='net::ERR_PROXY_CONNECTION_FAILED'
named_local=$(call '{"command":"navigate","url":"http://loopback-check.openmausbot.invalid:7780/"}')
check "a name that resolves to this VM" "$(printf '%s' "$named_local" | cut -c1-190)"
[[ $named_local == *'"ok":false'* && $named_local == *"$closed_port"* ]] || { echo "FAIL: the browser did not refuse a name that resolves to the VM itself" >&2; exit 1; }
refused=$(call '{"command":"navigate","url":"https://us.i.posthog.com/"}')
check "analytics host is refused" "$(printf '%s' "$refused" | cut -c1-150)"
[[ $refused == *'"ok":false'* && $refused == *"$closed_port"* ]] || { echo "FAIL: the browser did not refuse its vendor's analytics host" >&2; exit 1; }
if [[ $(guest 'systemd-detect-virt 2>/dev/null || true') != kvm ]]; then
  shown=""
  for _ in $(seq 1 10); do
    shown=$(guest 'eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|HYPRLAND_INSTANCE_SIGNATURE|XDG_RUNTIME_DIR)=" | sed "s/^/export /")"; hyprctl activeworkspace 2>/dev/null | head -1' || true)
    [[ $shown == "workspace ID 2 "* ]] && break
    sleep 1
  done
  check "browser on screen while in use (no KVM)" "$shown"
  [[ $shown == "workspace ID 2 "* ]] || { echo "FAIL: the browser's workspace is not shown while the browser is in use" >&2; exit 1; }
  repeat=$(guest 'eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|HYPRLAND_INSTANCE_SIGNATURE|XDG_RUNTIME_DIR)=" | sed "s/^/export /")"; hyprctl getoption input:repeat_delay 2>/dev/null | head -1' || true)
  check "key repeat delay (no KVM)" "$repeat"
  [[ $repeat == "int: 5000" ]] || { echo "FAIL: the key repeat delay is not the long one an emulated VM needs" >&2; exit 1; }
fi
quiet=$(guest 'pgrep -fa "^/opt/browseros-neo/squashfs-root/opt/browserclaw/browserclaw " | grep -c -E -- " --hide-crash-restore-bubble( |\$)" || true')
check "browser processes started with --hide-crash-restore-bubble" "$quiet"
[[ $quiet =~ ^[1-9][0-9]*$ ]] || { echo "FAIL: the browser was not started with --hide-crash-restore-bubble" >&2; exit 1; }
stray=$(guest 'pgrep -f -c "^/opt/browseros-neo/squashfs-root/opt/browserclaw/BrowserClawServer" || true')
check "browser server processes" "$stray"
[[ $stray == 1 ]] || { echo "FAIL: expected one browser server process, found $stray" >&2; exit 1; }
console=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CONSOLE_PORT/" || true)
check "Omarchy Server console" "HTTP $console"
[[ $console == 200 ]] || { echo "FAIL: the Omarchy Server console does not answer" >&2; exit 1; }
ended=$(call '{"command":"close"}')
check "check session ended" "$ended"
[[ $ended == *'"ok":true'* ]] || { echo "FAIL: the proxy did not end the check's session" >&2; exit 1; }
echo "VERIFY_OK $OMB_VM_NAME"
