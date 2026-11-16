#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
mkdir -p "$CACHE"

fetch_file() {
  local url=$1 out=$2 sha=$3
  if [[ -f $out && $(sha256_of "$out") == "$sha" ]]; then echo "cached $(basename "$out")"; return; fi
  rm -f "$out"
  if ! curl -fL -C - --retry 5 --retry-delay 5 -sS "$url" -o "$out.part"; then
    rm -f "$out.part"
    curl -fL --retry 5 --retry-delay 5 -sS "$url" -o "$out.part"
  fi
  local got; got=$(sha256_of "$out.part")
  if [[ $got != "$sha" ]]; then
    rm -f "$out.part"
    echo "$(basename "$out"): sha256 $got, expected $sha" >&2
    exit 1
  fi
  mv -f "$out.part" "$out"
  chmod a-w "$out"
  echo "fetched $(basename "$out")"
}

fetch_file "$(pin omarchy.x86_64.url)" "$CACHE/omarchy-$(pin omarchy.version).qcow2" "$(pin omarchy.x86_64.sha256)"
for f in vmlinuz initrd cmdline; do
  fetch_file "$(pin omarchy.x86_64.unpacked)$f" "$CACHE/omarchy-$(pin omarchy.version).$f" "$(pin "omarchy.x86_64.unpackedSha256.$f")"
done
fetch_file "$(pin browserosNeo.x86_64.url)" "$CACHE/browseros-neo-$(pin browserosNeo.version)-x86_64.AppImage" "$(pin browserosNeo.x86_64.sha256)"

SRC="$CACHE/omarchy-server-$(pin omarchyServer.commit)"
if [[ ! -d $SRC/.git ]]; then
  rm -rf "$SRC"
  git init -q "$SRC"
  git -C "$SRC" remote add origin "$(pin omarchyServer.repository)"
  git -C "$SRC" fetch -q --depth 1 origin "$(pin omarchyServer.commit)"
  git -C "$SRC" checkout -q -B main FETCH_HEAD
fi
[[ $(git -C "$SRC" rev-parse HEAD) == "$(pin omarchyServer.commit)" ]] || { echo "omarchy-server is not at the pinned commit" >&2; exit 1; }
[[ -z $(git -C "$SRC" status --porcelain) ]] || { echo "omarchy-server checkout is dirty" >&2; exit 1; }
[[ $(sha256_of "$SRC/helper/helper.mjs") == "$(pin omarchyServer.helperSha256)" ]] || { echo "omarchy-server helper does not match the reviewed digest" >&2; exit 1; }
echo "FETCH_OK $(pin omarchy.version) / omarchy-server $(pin omarchyServer.version) / BrowserOS neo $(pin browserosNeo.version)"
