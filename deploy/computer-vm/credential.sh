#!/bin/bash
# systemd SMBIOS tmpfiles.extra credential injected on boot; passwordless sudo is removed once provisioned.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
echo "d /home/$GUEST_USER/.ssh 0700 $GUEST_USER $GUEST_USER -"
echo "f+ /home/$GUEST_USER/.ssh/authorized_keys 0600 $GUEST_USER $GUEST_USER - $(cat "$SECRETS/id_ed25519.pub")"
echo 'd /etc/systemd/logind.conf.d 0755 root root -'
echo 'f+ /etc/systemd/logind.conf.d/50-openmausbot.conf 0644 root root - [Login]\nHandlePowerKey=poweroff\n'
if [[ ! -f $VM/provisioned ]]; then
  echo "f+ /etc/sudoers.d/50-openmausbot-provision 0440 root root - $GUEST_USER"' ALL=(ALL) NOPASSWD: ALL\nDefaults env_keep += http_proxy\nDefaults env_keep += https_proxy\nDefaults env_keep += no_proxy\nDefaults env_keep += HTTP_PROXY\nDefaults env_keep += HTTPS_PROXY\nDefaults env_keep += NO_PROXY\n'
else
  echo 'r /etc/sudoers.d/50-openmausbot-provision'
fi
if [[ -n ${OMB_VM_EGRESS_RELAY:-} ]]; then
  echo 'L+ /etc/systemd/system/systemd-resolved.service - - - - /dev/null'
  echo 'L+ /etc/systemd/system/systemd-timesyncd.service - - - - /dev/null'
fi
