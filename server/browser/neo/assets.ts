import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_ROOT } from "../../proxy-paths.ts";

export interface NeoGuestAsset {
  readonly text: string;
  readonly sha12: string;
}

let cachedAssets: { proxy: NeoGuestAsset; pac: NeoGuestAsset } | null = null;

function resolveGuestAssetPath(fileName: string): string {
  const bundled = join(SERVER_ROOT, "browser", "neo", fileName);
  if (existsSync(bundled)) return bundled;
  return join(SERVER_ROOT, "..", "deploy", "computer-vm", "guest", fileName);
}

function readAsset(fileName: string): NeoGuestAsset {
  const text = readFileSync(resolveGuestAssetPath(fileName), "utf8");
  const sha12 = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return { text, sha12 };
}

export function loadNeoGuestAssets(): { proxy: NeoGuestAsset; pac: NeoGuestAsset } {
  if (cachedAssets) return cachedAssets;
  cachedAssets = {
    proxy: readAsset("omb-browser-proxy.mjs"),
    pac: readAsset("omb-browser.pac"),
  };
  return cachedAssets;
}
