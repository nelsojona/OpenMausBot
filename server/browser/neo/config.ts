import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import * as boat from "../../boat.ts";
import type { AppConfig } from "../../config.ts";
import { browserOsNeoEnabled, type BrowserNeoConfig, type BrowserNeoScreenConfig } from "../config.ts";

export interface NeoScreenTarget {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
}

export type NeoRoute =
  | { readonly kind: "disabled" }
  | { readonly kind: "misconfigured"; readonly reason: string }
  | { readonly kind: "boat"; readonly owner: string; readonly ownerName?: string; readonly upstreamProxy?: string }
  | { readonly kind: "proxy"; readonly endpoint: string; readonly token: string; readonly screen?: NeoScreenTarget };

const proxyTargetSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  token: z.string().trim().min(1).max(512).optional(),
  tokenFile: z.string().trim().min(1).max(1024).optional(),
  screen: z
    .object({
      vnc: z.string().trim().min(1).max(256).optional(),
      password: z.string().trim().max(512).optional(),
      passwordFile: z.string().trim().min(1).max(1024).optional(),
    })
    .optional(),
});

const proxyEntrySchema = z.union([
  z.enum(["local", "container", "cloud"]),
  proxyTargetSchema,
]);

const proxyFileSchema = z.object({
  default: proxyEntrySchema.optional(),
  bots: z.record(z.string(), proxyEntrySchema).optional(),
});

type ProxyFileData = z.output<typeof proxyFileSchema>;

interface CachedProxyFile {
  mtimeMs: number;
  size: number;
  data: ProxyFileData | null;
  error?: string;
}

const fileCache = new Map<string, CachedProxyFile>();

function readProxyFile(dataDir: string): { present: boolean; data: ProxyFileData | null; error?: string } {
  const filePath = join(dataDir, "browser-proxies.json");
  let st;
  try {
    st = statSync(filePath);
  } catch {
    fileCache.delete(filePath);
    return { present: false, data: null };
  }
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return { present: true, data: cached.data, error: cached.error };
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const parsed = proxyFileSchema.safeParse(raw);
    if (!parsed.success) {
      const error = "browser-proxies.json is invalid.";
      fileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, data: null, error });
      return { present: true, data: null, error };
    }
    fileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, data: parsed.data });
    return { present: true, data: parsed.data };
  } catch {
    const error = "browser-proxies.json could not be read.";
    fileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, data: null, error });
    return { present: true, data: null, error };
  }
}

function resolveSecretFile(filePath: string, dataDir: string): string {
  return isAbsolute(filePath) ? filePath : resolve(dataDir, filePath);
}

function readSecretText(inline: string | undefined, filePath: string | undefined, dataDir: string): string | undefined {
  if (inline && inline.trim().length > 0) return inline.trim();
  if (!filePath) return undefined;
  try {
    const value = readFileSync(resolveSecretFile(filePath, dataDir), "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseScreenTarget(screen: BrowserNeoScreenConfig | undefined, dataDir: string): NeoScreenTarget | undefined {
  if (!screen?.vnc) return undefined;
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(screen.vnc.trim());
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return undefined;
  const password = readSecretText(screen.password, screen.passwordFile, dataDir);
  return { host: match[1]!, port, ...(password ? { password } : {}) };
}

function buildProxyEndpoint(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    const base = parsed.pathname === "/" || parsed.pathname === "" ? "/v1/page-browser" : parsed.pathname;
    parsed.pathname = base;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function resolveHttpEntry(
  entry: { url?: string; token?: string; tokenFile?: string; screen?: BrowserNeoScreenConfig },
  dataDir: string,
): NeoRoute {
  if (!entry.url) {
    return { kind: "misconfigured", reason: "BrowserOS neo proxy URL is not configured." };
  }
  const endpoint = buildProxyEndpoint(entry.url);
  if (!endpoint) {
    return { kind: "misconfigured", reason: "BrowserOS neo proxy URL must be a valid HTTP(S) address without credentials." };
  }
  const token = readSecretText(entry.token, entry.tokenFile, dataDir);
  if (!token || token.length < 24) {
    return { kind: "misconfigured", reason: "BrowserOS neo proxy token is missing or shorter than 24 characters." };
  }
  const screen = parseScreenTarget(entry.screen, dataDir);
  return { kind: "proxy", endpoint, token, ...(screen ? { screen } : {}) };
}

function discoverDefaultLocalVmProxy(env: NodeJS.ProcessEnv = process.env): NeoRoute | null {
  const vmRoot = env.OMB_VM_ROOT ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "openmausbot", "vms");
  const vmName = env.OMB_VM_NAME ?? "omb-computer-1";
  const vmDir = join(vmRoot, vmName);
  if (!existsSync(join(vmDir, "provisioned"))) return null;
  const tokenPath = join(vmDir, "secrets", "browser-proxy.token");
  if (!existsSync(tokenPath)) return null;
  const proxyPort = Number(env.OMB_VM_PROXY_PORT ?? "7791");
  const screenPort = Number(env.OMB_VM_SCREEN_PORT ?? "5981");
  const pwFile = join(vmDir, "secrets", "console-owner-password.txt");
  return resolveHttpEntry(
    {
      url: `http://127.0.0.1:${Number.isInteger(proxyPort) && proxyPort > 0 ? proxyPort : 7791}`,
      tokenFile: tokenPath,
      screen: {
        vnc: `127.0.0.1:${Number.isInteger(screenPort) && screenPort > 0 ? screenPort : 5981}`,
        ...(existsSync(pwFile) ? { passwordFile: pwFile } : {}),
      },
    },
    vmDir,
  );
}

export interface NeoRouteBotInput {
  readonly id: string;
  readonly name?: string;
  readonly computer?: string;
  readonly cloudBackend?: string;
  readonly computerOwner?: string;
}

export function neoFeatureActive(cfg: AppConfig, dataDir: string): boolean {
  if (cfg.features?.browserOsNeo === false) return false;
  if (browserOsNeoEnabled(cfg)) return true;
  const proxyFile = readProxyFile(dataDir);
  return proxyFile.present && Boolean(proxyFile.data?.default || (proxyFile.data?.bots && Object.keys(proxyFile.data.bots).length > 0));
}

export function resolveNeoRoute(
  bot: NeoRouteBotInput | null,
  cfg: AppConfig,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): NeoRoute {
  if (cfg.features?.browserOsNeo === false) return { kind: "disabled" };
  const proxyFile = readProxyFile(dataDir);
  if (proxyFile.error) return { kind: "misconfigured", reason: proxyFile.error };

  const neoCfg: BrowserNeoConfig | undefined = cfg.browserEngine?.neo;
  if (bot && neoCfg?.optOutBots?.includes(bot.id)) return { kind: "disabled" };

  const botOverride = bot ? proxyFile.data?.bots?.[bot.id] : undefined;
  if (botOverride === "local" || botOverride === "container") return { kind: "disabled" };
  if (botOverride === "cloud") {
    if (!boat.boatConfigured(cfg)) {
      return { kind: "misconfigured", reason: "BrowserOS neo cloud desktop routing requires a Boat API key." };
    }
    return { kind: "boat", owner: bot?.computerOwner ?? bot?.id ?? "default", ownerName: bot?.name };
  }
  if (botOverride && typeof botOverride === "object") {
    return resolveHttpEntry(botOverride, dataDir);
  }

  const enabledGlobally = browserOsNeoEnabled(cfg) || Boolean(proxyFile.data?.default);
  if (!enabledGlobally) return { kind: "disabled" };

  if (
    bot &&
    neoCfg?.cloudDesktop !== false &&
    bot.computer === "cloud" &&
    bot.cloudBackend !== "vps" &&
    boat.boatConfigured(cfg)
  ) {
    return { kind: "boat", owner: bot.computerOwner ?? bot.id, ownerName: bot.name };
  }

  if (proxyFile.data?.default) {
    const def = proxyFile.data.default;
    if (def === "local" || def === "container") return { kind: "disabled" };
    if (def === "cloud") {
      if (!boat.boatConfigured(cfg)) {
        return { kind: "misconfigured", reason: "BrowserOS neo cloud desktop routing requires a Boat API key." };
      }
      return { kind: "boat", owner: bot?.computerOwner ?? bot?.id ?? "default", ownerName: bot?.name };
    }
    return resolveHttpEntry(def, dataDir);
  }

  if (neoCfg?.url) {
    return resolveHttpEntry(neoCfg, dataDir);
  }

  const discovered = discoverDefaultLocalVmProxy(env);
  if (discovered) return discovered;

  if (bot && neoCfg?.cloudDesktop !== false && boat.boatConfigured(cfg) && bot.computer !== "local" && bot.cloudBackend !== "vps") {
    return { kind: "boat", owner: bot.computerOwner ?? bot.id, ownerName: bot.name };
  }

  return {
    kind: "misconfigured",
    reason: "BrowserOS neo is enabled, but no VM proxy or cloud desktop is configured.",
  };
}

export function resolveNeoVmScreen(
  cfg: AppConfig,
  dataDir: string,
  bot: NeoRouteBotInput | null = null,
  env: NodeJS.ProcessEnv = process.env,
): NeoScreenTarget | null {
  const route = resolveNeoRoute(bot, cfg, dataDir, env);
  return route.kind === "proxy" && route.screen ? route.screen : null;
}
