#!/bin/bash
set -euo pipefail
P=/tmp/omb-provision
say() { printf '==> %s\n' "$*"; }
[[ $(uname -m) == x86_64 ]] || { echo "the default VM is x86_64; this guest is $(uname -m)" >&2; exit 1; }
[[ $(id -u) -ne 0 ]] || { echo "run as the desktop user, not root" >&2; exit 1; }
session_env() { eval "$(systemctl --user show-environment | grep -E '^(WAYLAND_DISPLAY|HYPRLAND_INSTANCE_SIGNATURE|XDG_CURRENT_DESKTOP|OMARCHY_PATH)=' | sed 's/^/export /')"; }
trap 'sudo -n rm -f /etc/sudoers.d/50-openmausbot-provision 2>/dev/null || true' EXIT
host_address=${OMB_VM_HOST_ADDRESS:-10.0.2.2}
[[ $host_address =~ ^[0-9.]+$ ]] || { echo "OMB_VM_HOST_ADDRESS must be an IPv4 address" >&2; exit 1; }
quiet_desktop() {
  if systemctl --user is-active --quiet graphical-session.target && command -v omarchy-shell >/dev/null 2>&1; then
    (session_env; omarchy-shell notifications setDnd on; omarchy-shell notifications dismissAll) >/dev/null 2>&1 || true
  fi
}

say "Desktop stays awake"
shell_config="$HOME/.config/omarchy/shell.json"
if [[ -f $shell_config ]]; then
  idle=$(mktemp)
  jq '.idle.screensaver = 0 | .idle.lock = 0' "$shell_config" > "$idle"
  cat "$idle" > "$shell_config"
  rm -f "$idle"
fi
mkdir -p "$HOME/.local/state/omarchy/indicators"
touch "$HOME/.local/state/omarchy/indicators/stay-awake"

say "Desktop notifications off"
quiet_desktop
mkdir -p "$HOME/.local/state/omarchy/notifications"
grep -qs '"dnd":true' "$HOME/.local/state/omarchy/notifications/quiet.json" || printf '{"dnd":true}\n' > "$HOME/.local/state/omarchy/notifications/quiet.json"

say "Package databases"
pacman -Si nodejs >/dev/null 2>&1 || sudo pacman -Sy --noconfirm >/dev/null
sudo pacman -S --needed --noconfirm nodejs npm >/dev/null

say "Omarchy Server at $OMB_OMARCHY_SERVER_COMMIT"
SRC="$HOME/.local/share/openmausbot/omarchy-server-src"
rm -rf "$SRC"
mkdir -p "$(dirname "$SRC")"
mv "$P/omarchy-server-src" "$SRC"
[[ $(git -C "$SRC" rev-parse HEAD) == "$OMB_OMARCHY_SERVER_COMMIT" ]] || { echo "source is not the pinned commit" >&2; exit 1; }
[[ -z $(git -C "$SRC" status --porcelain) ]] || { echo "source differs from the pinned commit" >&2; exit 1; }
git -C "$SRC" remote remove origin 2>/dev/null || true
OMB_OWNER_PASSWORD_FILE="$P/console-owner-password.txt" node --input-type=module -e '
import { readFileSync } from "node:fs";
const [source, data, name] = process.argv.slice(1);
const { openAccounts } = await import(`${source}/omarchyd/accounts.mjs`);
const accounts = await openAccounts(data);
if (!accounts.hasOwner()) {
  await accounts.createOwner({ name, password: readFileSync(process.env.OMB_OWNER_PASSWORD_FILE, "utf8").trim() });
}
if (!accounts.hasOwner()) process.exit(1);
' "$SRC" "$HOME/.local/share/omarchy-server/omarchyd" "$USER"
OMARCHY_SERVER_REPO="file://$SRC" bash "$SRC/install.sh"
[[ $(sha256sum /usr/local/libexec/omarchy-server/helper.mjs | cut -d" " -f1) == "$OMB_OMARCHY_SERVER_HELPER_SHA256" ]] || { echo "the installed root helper is not the reviewed one" >&2; exit 1; }
[[ $(git -C "$HOME/.local/share/omarchy-server/app" rev-parse HEAD) == "$OMB_OMARCHY_SERVER_COMMIT" ]] || { echo "the installed Omarchy Server is not the pinned commit" >&2; exit 1; }
# Omarchy Server 0.9.13 opens broad port ranges on install; close them and restrict 7780 to the VM host.
for rule in 40000:49999/tcp 40000:49999/udp 7800:7899/tcp 7780/tcp; do
  sudo ufw delete allow "$rule" >/dev/null 2>&1 || true
done
sudo ufw allow from "$host_address" to any port 7780 proto tcp comment 'Omarchy Server console, VM host only' >/dev/null
sudo loginctl enable-linger "$USER"

say "BrowserOS neo"
[[ $(sha256sum "$P/browseros-neo.AppImage" | cut -d" " -f1) == "$OMB_NEO_SHA256" ]] || { echo "the browser download does not match its pin" >&2; exit 1; }
sudo install -d -o root -g root -m 0755 /opt/browseros-neo /opt/openmausbot
sudo install -o root -g root -m 0755 "$P/browseros-neo.AppImage" /opt/browseros-neo/BrowserOS_neo.AppImage
(cd /opt/browseros-neo && sudo rm -rf squashfs-root && sudo ./BrowserOS_neo.AppImage --appimage-extract >/dev/null && sudo chmod -R a+rX squashfs-root)
mkdir -p "$HOME/.browserclaw"
[[ -f $HOME/.browserclaw/analytics.json ]] || printf '{"enabled":false}\n' > "$HOME/.browserclaw/analytics.json"

say "Browser proxy"
sudo install -o root -g root -m 0644 "$P/omb-browser-proxy.mjs" /opt/openmausbot/omb-browser-proxy.mjs
sudo install -o root -g root -m 0755 "$P/omb-browser-view" /opt/openmausbot/omb-browser-view
mkdir -p "$HOME/.config/openmausbot" "$HOME/.config/systemd/user"
chmod 700 "$HOME/.config/openmausbot"
install -m 0600 "$P/browser-proxy.token" "$HOME/.config/openmausbot/browser-proxy.token"
upstream=DIRECT
if [[ -n ${OMB_BROWSER_PROXY:-} ]]; then
  [[ $OMB_BROWSER_PROXY =~ ^[A-Za-z0-9.-]+:[0-9]+$ ]] || { echo "OMB_BROWSER_PROXY must be host:port" >&2; exit 1; }
  upstream="PROXY $OMB_BROWSER_PROXY"
fi
pac=$(sed "s|__OMB_UPSTREAM__|$upstream|" "$P/omb-browser.pac")
[[ $pac != *__OMB_* ]] || { echo "the browser auto-config still has a placeholder to fill in" >&2; exit 1; }
printf 'OMB_BROWSER_FLAGS=--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,%s\n' "$(printf '%s' "$pac" | base64 -w0)" > "$HOME/.config/openmausbot/browser.env"
# BrowserOS neo 0.52.1.1 opens agent tabs behind page 1 with no bring-to-front tool, and requires its default debugging port 9110.
printf 'OMB_BROWSER_PROXY_FRONT_TAB=1\n' > "$HOME/.config/openmausbot/browser-proxy.env"
grep -q ' loopback-check.openmausbot.invalid$' /etc/hosts || printf '127.0.0.1 loopback-check.openmausbot.invalid\n' | sudo tee -a /etc/hosts >/dev/null
hypr_config="$HOME/.config/hypr/hyprland.lua"
if [[ $(systemd-detect-virt 2>/dev/null || true) != kvm && -f $hypr_config ]]; then
  grep -q omb-browser-workspace "$hypr_config" || printf '\n-- omb-browser-workspace: emulated VM keeps the browser off workspace 1 when idle.\no.window("chromium-browser", { workspace = "2 silent" })\n' >> "$hypr_config"
  printf 'OMB_BROWSER_PROXY_ACTIVE_HOOK=/opt/openmausbot/omb-browser-view show\nOMB_BROWSER_PROXY_IDLE_HOOK=/opt/openmausbot/omb-browser-view hide\n' >> "$HOME/.config/openmausbot/browser-proxy.env"
  input_config="$HOME/.config/hypr/input.lua"
  if [[ -f $input_config ]]; then
    grep -q omb-key-repeat "$input_config" || printf '\n-- omb-key-repeat: 5000 ms repeat delay under software TCG emulation.\nhl.config({ input = { repeat_delay = 5000 } })\n' >> "$input_config"
  fi
  (session_env; hyprctl reload) >/dev/null 2>&1 || true
fi
install -m 0644 "$P/omb-browser.service" "$P/omb-browser-proxy.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable -q omb-browser.service omb-browser-proxy.service
systemctl --user restart omb-browser-proxy.service
if systemctl --user is-active --quiet graphical-session.target; then systemctl --user restart omb-browser.service; fi
sudo ufw allow from "$host_address" to any port 7791 proto tcp comment 'OpenMausBot browser proxy, VM host only' >/dev/null
sudo ufw deny out to "$host_address" comment 'OpenMausBot: VM does not call its host' >/dev/null
sudo ufw deny out to 169.254.0.0/16 comment 'OpenMausBot: no link-local services' >/dev/null

say "SSH takes keys only"
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' | sudo tee /etc/ssh/sshd_config.d/00-openmausbot.conf >/dev/null
sudo systemctl reload sshd

if systemctl --user is-active --quiet omb-browser.service; then
  say "Waiting for the browser"
  ready=""
  for _ in $(seq 1 90); do
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' -X POST http://127.0.0.1:9010/mcp \
      -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"omb-provision","version":"1"}}}' || true)
    if [[ $code == 200 ]]; then ready=1; break; fi
    sleep 2
  done
  [[ -n $ready ]] || { echo "the browser's agent endpoint did not come up" >&2; exit 1; }
fi
quiet_desktop

say "Account"
printf '%s:%s\n' "$USER" "$(cat "$P/vm-user-password.txt")" | sudo chpasswd

say "Clean up"
rm -rf "$P"
echo "PROVISION_OK"
