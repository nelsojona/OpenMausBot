#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
[[ -f $RUN/qemu.pid ]] || { echo "not running"; exit 0; }
pid=$(cat "$RUN/qemu.pid")
command=${1:-system_powerdown}
python3 - "$RUN/qmp.sock" "$command" <<'PY'
import json, socket, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect(sys.argv[1]); f = s.makefile("rw")
f.readline()
for cmd in ("qmp_capabilities", sys.argv[2]):
    f.write(json.dumps({"execute": cmd}) + "\n"); f.flush()
    while True:
        line = f.readline()
        if not line or "return" in line or "error" in line:
            break
PY
for _ in $(seq 1 1800); do kill -0 "$pid" 2>/dev/null || { echo "stopped"; exit 0; }; sleep 0.1; done
echo "still running after 180 s" >&2; exit 1
