# Omarchy Server + BrowserOS neo VM Recipe

Builds and runs a QEMU virtual machine running **Omarchy 4.5.0**, **Omarchy Server 0.9.13**, and **BrowserOS neo (`browserclaw/v0.52.0` / `0.52.1.1`)** behind a narrowed bearer-token proxy (`guest/omb-browser-proxy.mjs`).

## Quick start

```bash
bash deploy/computer-vm/fetch.sh
bash deploy/computer-vm/boot.sh
bash deploy/computer-vm/provision.sh
bash deploy/computer-vm/verify.sh
```

Stop the VM cleanly:

```bash
bash deploy/computer-vm/stop.sh
```

## Host loopback endpoints

All ports bind exclusively to `127.0.0.1` on the host; secrets are generated per VM in `$OMB_VM_HOME/vms/$OMB_VM_NAME/secrets` (`~/.openmausbot-vm/vms/default/secrets` by default):

| Service | Host endpoint | Secret file |
| --- | --- | --- |
| Narrowed BrowserOS neo proxy | `http://127.0.0.1:7781` | `secrets/browser-proxy.token` |
| VM desktop VNC (RFB) | `127.0.0.1:5981` | `secrets/screen-password.txt` |
| Omarchy Server console | `http://127.0.0.1:7780` | `secrets/console-owner-password.txt` |
| Guest SSH (ed25519 key only) | `127.0.0.1:2322` | `secrets/id_ed25519` |

## Connecting OpenMausBot

Enable `features.browserOsNeo: true` in `<DATA_DIR>/config.json` (or `browserEngine.engine: "browseros-neo"`), and point `browserEngine.neo` or `<DATA_DIR>/browser-proxies.json` at the VM:

```json
{
  "default": {
    "url": "http://127.0.0.1:7781",
    "tokenFile": "/path/to/.openmausbot-vm/vms/default/secrets/browser-proxy.token",
    "screen": {
      "vnc": "127.0.0.1:5981",
      "passwordFile": "/path/to/.openmausbot-vm/vms/default/secrets/screen-password.txt"
    }
  },
  "bots": {
    "keep-local-bot-id": "local"
  }
}
```

Bots working on a **cloud desktop (`boat.dev`)** automatically provision and start BrowserOS neo + `omb-browser-proxy.mjs` inside their sandbox on `DISPLAY=:0` when `features.browserOsNeo` is enabled, with no public port exposed.
