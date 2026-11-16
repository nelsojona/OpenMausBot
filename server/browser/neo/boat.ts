import * as boat from "../../boat.ts";
import type { AppConfig } from "../../config.ts";
import { loadNeoGuestAssets } from "./assets.ts";
import { BROWSEROS_NEO_PIN, type NeoArch } from "./pins.ts";

const NEO_ROOT = "$HOME/.mausbot-neo";
const PROXY_PORT = 7791;
const MCP_PORT = 9010;
const UPLOAD_CHUNK = 48_000;
const INLINE_REPLY_LIMIT = 60_000;

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export interface BoatNeoOptions {
  ownerName?: string;
  provisionIfMissing?: boolean;
  upstreamProxy?: string;
  signal?: AbortSignal;
  onUsed?: (owner: string) => void;
  artifactOverrides?: Partial<Record<NeoArch, { url: string; sha256: string }>>;
}

const inFlightEnsure = new Map<string, Promise<string>>();

async function runIsolated(
  cfg: AppConfig,
  boxId: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  return boat.runCommand(cfg, boxId, boat.isolatedRemoteCommand(command), { timeoutMs, signal });
}

async function startDetachedUntracked(
  cfg: AppConfig,
  boxId: string,
  command: string,
  signal?: AbortSignal,
): Promise<void> {
  boat.assertBoatNotDeleting(boxId);
  const limit = AbortSignal.timeout(20_000);
  const res = await boat.boatFetch(cfg, `/sandboxes/${boxId}/commands`, {
    method: "POST",
    body: JSON.stringify({ command: boat.isolatedRemoteCommand(command), detached: true }),
    signal: signal ? AbortSignal.any([signal, limit]) : limit,
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw new Error(boat.boatErrorMessage(res.status, "starting BrowserOS neo on the cloud desktop", body));
  }
}

async function uploadBase64File(
  cfg: AppConfig,
  boxId: string,
  remoteExpr: string,
  content: string,
  mode: string,
  signal?: AbortSignal,
): Promise<void> {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const init = await runIsolated(cfg, boxId, `mkdir -p ${NEO_ROOT} && : > ${remoteExpr}.b64`, 20_000, signal);
  if (!init.ok) {
    throw new Error(`Preparing BrowserOS neo files failed on the cloud desktop: ${(init.stderr || init.stdout).trim().slice(0, 240)}`);
  }
  for (let offset = 0; offset < encoded.length; offset += UPLOAD_CHUNK) {
    const chunk = encoded.slice(offset, offset + UPLOAD_CHUNK);
    const out = await runIsolated(cfg, boxId, `printf %s ${shellQuote(chunk)} >> ${remoteExpr}.b64`, 20_000, signal);
    if (!out.ok) {
      throw new Error(`Uploading BrowserOS neo files failed on the cloud desktop: ${(out.stderr || out.stdout).trim().slice(0, 240)}`);
    }
  }
  const unpack = await runIsolated(
    cfg,
    boxId,
    `base64 -d ${remoteExpr}.b64 > ${remoteExpr}.tmp && chmod ${mode} ${remoteExpr}.tmp && mv ${remoteExpr}.tmp ${remoteExpr} && rm -f ${remoteExpr}.b64`,
    20_000,
    signal,
  );
  if (!unpack.ok) {
    throw new Error(`Installing BrowserOS neo files failed on the cloud desktop: ${(unpack.stderr || unpack.stdout).trim().slice(0, 240)}`);
  }
}

function normalizeArch(raw: string): NeoArch {
  const arch = raw.trim();
  if (arch === "x86_64" || arch === "amd64") return "x86_64";
  if (arch === "aarch64" || arch === "arm64") return "aarch64";
  throw new Error(`Unsupported cloud desktop CPU architecture for BrowserOS neo: ${arch || "unknown"}`);
}

async function resolveReadyBoxId(cfg: AppConfig, owner: string, options?: BoatNeoOptions): Promise<string> {
  const ready = await boat.readyBoat(cfg, owner, 90_000);
  if (ready && typeof ready.id === "string") return ready.id;
  if (options?.provisionIfMissing === false) {
    throw new Error("No cloud desktop is running for this bot yet.");
  }
  const created = await boat.provisionBoat(cfg, owner, options?.ownerName ?? owner);
  return created.boxId;
}

async function ensureBoatNeoInner(cfg: AppConfig, owner: string, options?: BoatNeoOptions): Promise<string> {
  const boxId = await resolveReadyBoxId(cfg, owner, options);
  const assets = loadNeoGuestAssets();
  const upstreamRule = options?.upstreamProxy ? `PROXY ${options.upstreamProxy}` : "DIRECT";
  const pacRendered = assets.pac.text.replace("__OMB_UPSTREAM__", upstreamRule);
  const proxyFile = `${NEO_ROOT}/omb-browser-proxy-${assets.proxy.sha12}.mjs`;
  const pacKey = Buffer.from(upstreamRule).toString("hex").slice(0, 16);
  const pacFile = `${NEO_ROOT}/omb-browser-${assets.pac.sha12}-${pacKey}.pac`;
  const appDir = `${NEO_ROOT}/neo-${BROWSEROS_NEO_PIN.version}`;
  const appRun = `${appDir}/AppRun`;
  const tokenFile = `${NEO_ROOT}/proxy.token`;

  const fastProbe = await runIsolated(
    cfg,
    boxId,
    `test -s ${proxyFile} && test -s ${pacFile} && test -s ${tokenFile} && curl -fsS -m 2 http://127.0.0.1:${PROXY_PORT}/healthz`,
    12_000,
    options?.signal,
  );
  if (fastProbe.ok) {
    try {
      const parsed = JSON.parse(fastProbe.stdout.trim()) as { ok?: boolean; browser?: string };
      if (parsed.ok === true && parsed.browser === "browseros-neo") {
        options?.onUsed?.(owner);
        return boxId;
      }
    } catch {}
  }

  const probe = await runIsolated(
    cfg,
    boxId,
    [
      `mkdir -p ${NEO_ROOT} "$HOME/.browserclaw"`,
      `printf '%s\\n' '{"enabled":false}' > "$HOME/.browserclaw/analytics.json"`,
      `if [ ! -s ${tokenFile} ]; then (umask 077 && node -e 'process.stdout.write(require("node:crypto").randomBytes(36).toString("base64url") + "\\n")' > ${tokenFile}); fi`,
      `echo "ARCH=$(uname -m)"`,
      `echo "NODE=$(node -v 2>/dev/null || true)"`,
      `test -x ${appRun} && echo "NEO_INSTALLED=1" || echo "NEO_INSTALLED=0"`,
      `test -s ${proxyFile} && echo "PROXY_INSTALLED=1" || echo "PROXY_INSTALLED=0"`,
      `test -s ${pacFile} && echo "PAC_INSTALLED=1" || echo "PAC_INSTALLED=0"`,
    ].join("; "),
    20_000,
    options?.signal,
  );
  if (!probe.ok) {
    throw new Error(`Could not inspect the cloud desktop for BrowserOS neo: ${(probe.stderr || probe.stdout).trim().slice(0, 240)}`);
  }
  const vars = Object.fromEntries(
    probe.stdout
      .split("\n")
      .map((line) => /^([A-Z_]+)=(.*)$/.exec(line.trim()))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map((m) => [m[1]!, m[2]!]),
  );
  const nodeMajor = Number(/^v(\d+)/.exec(vars.NODE ?? "")?.[1] ?? 0);
  if (nodeMajor < 22) {
    throw new Error("The cloud desktop needs Node.js 22 or newer to run the BrowserOS neo proxy.");
  }
  const arch = normalizeArch(vars.ARCH ?? "");

  if (vars.PROXY_INSTALLED !== "1") {
    await uploadBase64File(cfg, boxId, proxyFile, assets.proxy.text, "755", options?.signal);
  }
  if (vars.PAC_INSTALLED !== "1") {
    await uploadBase64File(cfg, boxId, pacFile, pacRendered, "644", options?.signal);
  }
  if (vars.NEO_INSTALLED !== "1") {
    const pin = options?.artifactOverrides?.[arch] ?? BROWSEROS_NEO_PIN[arch];
    const installCmd = [
      "set -euo pipefail",
      `tmp=$(mktemp -d ${NEO_ROOT}/install.XXXXXX)`,
      'trap \'rm -rf "$tmp"\' EXIT',
      `curl -fL --retry 3 --retry-delay 2 -o "$tmp/neo.AppImage" ${shellQuote(pin.url)}`,
      `echo "${pin.sha256}  $tmp/neo.AppImage" | sha256sum -c -`,
      'chmod 755 "$tmp/neo.AppImage"',
      '(cd "$tmp" && ./neo.AppImage --appimage-extract >/dev/null)',
      `rm -rf ${appDir} && mv "$tmp/squashfs-root" ${appDir}`,
    ].join("; ");
    const installed = await runIsolated(cfg, boxId, installCmd, 240_000, options?.signal);
    if (!installed.ok) {
      throw new Error(
        `Installing BrowserOS neo failed on the cloud desktop: ${(installed.stderr || installed.stdout).trim().slice(0, 300)}`,
      );
    }
  }

  const startCmd = [
    `mkdir -p ${NEO_ROOT}`,
    `if ! curl -fsS -m 1 http://127.0.0.1:${MCP_PORT}/mcp >/dev/null 2>&1 && ! pgrep -x browserclaw >/dev/null 2>&1 && ! pgrep -x BrowserClawServer >/dev/null 2>&1; then`,
    `  setsid env DISPLAY="\${DISPLAY:-:0}" ${appRun} --ozone-platform=x11 --no-first-run --no-default-browser-check --password-store=basic --hide-crash-restore-bubble --window-size=1280,800 --proxy-pac-url="file://${pacFile}" about:blank </dev/null >>${NEO_ROOT}/browser.log 2>&1 &`,
    "fi",
    `if ! curl -fsS -m 1 http://127.0.0.1:${PROXY_PORT}/healthz >/dev/null 2>&1; then`,
    `  pkill -f 'omb-browser-proxy-' 2>/dev/null || true`,
    `  setsid env OMB_BROWSER_PROXY_TOKEN_FILE=${tokenFile} OMB_BROWSER_PROXY_LISTEN=127.0.0.1:${PROXY_PORT} OMB_BROWSER_PROXY_UPSTREAM=http://127.0.0.1:${MCP_PORT}/mcp OMB_BROWSER_PROXY_FRONT_TAB=1 OMB_BROWSER_PROXY_LOG=${NEO_ROOT}/audit.jsonl node ${proxyFile} </dev/null >>${NEO_ROOT}/proxy.log 2>&1 &`,
    "fi",
  ].join("\n");
  await startDetachedUntracked(cfg, boxId, startCmd, options?.signal);

  const waitCmd = [
    "for i in $(seq 1 50); do",
    `  if curl -fsS -m 2 http://127.0.0.1:${PROXY_PORT}/healthz >/dev/null 2>&1 && (pgrep -x browserclaw >/dev/null 2>&1 || pgrep -x BrowserClawServer >/dev/null 2>&1 || ss -ltn 2>/dev/null | grep -q ':${MCP_PORT} '); then`,
    `    curl -fsS -m 2 http://127.0.0.1:${PROXY_PORT}/healthz && exit 0`,
    "  fi",
    "  sleep 0.4",
    "done",
    `tail -n 20 ${NEO_ROOT}/proxy.log ${NEO_ROOT}/browser.log >&2 2>/dev/null || true`,
    "exit 1",
  ].join("\n");
  const ready = await runIsolated(cfg, boxId, waitCmd, 25_000, options?.signal);
  if (!ready.ok) {
    throw new Error(
      `BrowserOS neo did not start in time on the cloud desktop: ${(ready.stderr || ready.stdout).trim().slice(0, 300)}`,
    );
  }
  options?.onUsed?.(owner);
  return boxId;
}

export function ensureBoatNeo(cfg: AppConfig, owner: string, options?: BoatNeoOptions): Promise<string> {
  const existing = inFlightEnsure.get(owner);
  if (existing) return existing;
  const run = ensureBoatNeoInner(cfg, owner, options).finally(() => {
    if (inFlightEnsure.get(owner) === run) inFlightEnsure.delete(owner);
  });
  inFlightEnsure.set(owner, run);
  return run;
}

const FORWARD_NODE_SCRIPT = [
  'const fs = require("node:fs");',
  'const crypto = require("node:crypto");',
  "const [tokenFile, port, session, payloadB64, inlineLimit] = process.argv.slice(1);",
  "(async () => {",
  '  const token = fs.readFileSync(tokenFile, "utf8").trim();',
  '  const body = Buffer.from(payloadB64, "base64").toString("utf8");',
  "  const res = await fetch(`http://127.0.0.1:${port}/v1/page-browser`, {",
  '    method: "POST",',
  '    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-omb-browser-session": session },',
  "    body,",
  "    signal: AbortSignal.timeout(22500),",
  "  });",
  "  const raw = Buffer.from(await res.arrayBuffer());",
  "  const envelope = Buffer.from(JSON.stringify({ status: res.status, body: raw.toString(\"utf8\") }), \"utf8\");",
  "  if (envelope.length <= Number(inlineLimit)) {",
  '    process.stdout.write("OMB_NEO_INLINE:" + envelope.toString("base64") + "\\n");',
  "  } else {",
  '    const file = `/tmp/omb-neo-reply-${crypto.randomUUID()}.json`;',
  "    fs.writeFileSync(file, envelope, { mode: 0o600 });",
  '    process.stdout.write("OMB_NEO_FILE:" + file + "\\n");',
  "  }",
  "})().catch((err) => { process.stderr.write(String(err?.message ?? err)); process.exit(1); });",
].join(" ");

export async function forwardBoatNeoCommand(
  cfg: AppConfig,
  owner: string,
  session: string,
  command: Record<string, unknown>,
  options?: BoatNeoOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const boxId = await ensureBoatNeo(cfg, owner, options);
  const payloadB64 = Buffer.from(JSON.stringify(command), "utf8").toString("base64");
  const cmd = `node -e ${shellQuote(FORWARD_NODE_SCRIPT)} "${NEO_ROOT}/proxy.token" ${PROXY_PORT} ${shellQuote(session)} ${shellQuote(payloadB64)} ${INLINE_REPLY_LIMIT}`;
  const out = await runIsolated(cfg, boxId, cmd, 25_000, options?.signal);
  options?.onUsed?.(owner);
  if (!out.ok) {
    return {
      status: 502,
      body: {
        ok: false,
        ...(command.command === "act" ? { completed: 0, uncertain: true } : {}),
        error: `The browser on the cloud desktop is unavailable: ${(out.stderr || out.stdout).trim().slice(0, 300) || "no answer"}`,
      },
    };
  }
  const line = out.stdout.split("\n").find((entry) => entry.startsWith("OMB_NEO_INLINE:") || entry.startsWith("OMB_NEO_FILE:"))?.trim();
  if (!line) {
    return { status: 502, body: { ok: false, error: "The cloud desktop returned an unreadable browser response." } };
  }
  let rawEnvelope: string;
  if (line.startsWith("OMB_NEO_INLINE:")) {
    rawEnvelope = Buffer.from(line.slice("OMB_NEO_INLINE:".length), "base64").toString("utf8");
  } else {
    const remoteFile = line.slice("OMB_NEO_FILE:".length);
    try {
      const b64 = await boat.readFileBase64(cfg, boxId, remoteFile, options?.signal);
      if (!b64) return { status: 502, body: { ok: false, error: "Could not read large browser response from the cloud desktop." } };
      rawEnvelope = Buffer.from(b64, "base64").toString("utf8");
    } finally {
      await runIsolated(cfg, boxId, `rm -f ${shellQuote(remoteFile)}`, 8_000).catch(() => null);
    }
  }
  const parsed = JSON.parse(rawEnvelope) as { status: number; body: string };
  return { status: parsed.status, body: JSON.parse(parsed.body) as Record<string, unknown> };
}
