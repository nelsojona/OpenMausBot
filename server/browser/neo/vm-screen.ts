import { browserSessionId } from "../../browser-engine.ts";
import { browserProfilePartitionTarget, type AppConfig } from "../../config.ts";
import type { ContainerComputerStatus } from "../../container-computer.ts";
import { desktopViewerUrl, type DesktopTarget } from "../../routes/desktop-viewer.ts";
import { forwardNeoHttpProxy } from "./client.ts";
import { resolveNeoRoute, resolveNeoVmScreen, type NeoRouteBotInput, type NeoScreenTarget } from "./config.ts";
import { BROWSEROS_NEO_PIN } from "./pins.ts";
import { probeRfbPort } from "./rfb-bridge.ts";

export const NEO_DESKTOP_TARGET_KEY = "neo";

const PROBE_CACHE_MS = 2_000;
const probeCache = new Map<string, { ok: boolean; expiresAt: number }>();

async function cachedProbe(host: string, port: number): Promise<boolean> {
  const key = `${host}:${port}`;
  const now = Date.now();
  const hit = probeCache.get(key);
  if (hit && hit.expiresAt > now) return hit.ok;
  const ok = await probeRfbPort(host, port);
  probeCache.set(key, { ok, expiresAt: Date.now() + PROBE_CACHE_MS });
  return ok;
}

export interface NeoScreenBotInput extends NeoRouteBotInput {
  readonly browserProfile?: string;
}

function usesAttachedChrome(cfg: AppConfig, browserProfile?: string): boolean {
  if (!browserProfile || browserProfile === "guest") return false;
  const profileId = browserProfilePartitionTarget(cfg, browserProfile)?.profileId ?? browserProfile;
  return cfg.browserProfiles?.some((profile) => profile.id === profileId && profile.browser === "chrome") === true;
}

function resolveAnyNeoScreen(
  cfg: AppConfig,
  dataDir: string,
  bots?: () => readonly NeoScreenBotInput[],
  env: NodeJS.ProcessEnv = process.env,
): NeoScreenTarget | null {
  const direct = resolveNeoVmScreen(cfg, dataDir, null, env);
  if (direct) return direct;
  if (!bots) return null;
  for (const bot of bots()) {
    if (usesAttachedChrome(cfg, bot.browserProfile)) continue;
    const found = resolveNeoVmScreen(cfg, dataDir, bot, env);
    if (found) return found;
  }
  return null;
}

export async function neoVmScreenLive(
  cfg: AppConfig,
  dataDir: string,
  bot: NeoScreenBotInput | null = null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (bot && usesAttachedChrome(cfg, bot.browserProfile)) return false;
  const screen = resolveNeoVmScreen(cfg, dataDir, bot, env);
  if (!screen) return false;
  return cachedProbe(screen.host, screen.port);
}

export function neoDesktopTarget(
  cfg: () => AppConfig,
  dataDir: string,
  bots?: () => readonly NeoScreenBotInput[],
  env: NodeJS.ProcessEnv = process.env,
): DesktopTarget {
  return {
    key: NEO_DESKTOP_TARGET_KEY,
    async resolve() {
      const screen = resolveAnyNeoScreen(cfg(), dataDir, bots, env);
      if (!screen || !(await probeRfbPort(screen.host, screen.port))) {
        throw Object.assign(new Error("BrowserOS neo VM desktop unavailable"), { status: 409 });
      }
      return {
        protocol: "rfb",
        host: screen.host,
        port: screen.port,
        password: screen.password ?? null,
        live: () => resolveAnyNeoScreen(cfg(), dataDir, bots, env) !== null,
      };
    },
  };
}

export function neoViewerLease(
  bot: NeoScreenBotInput,
  cfg: AppConfig,
  dataDir: string,
  leaseKey: string,
  controlLeaseId: string,
  beat: (key: string, leaseId: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): (() => boolean) | undefined {
  if (usesAttachedChrome(cfg, bot.browserProfile) || !resolveNeoVmScreen(cfg, dataDir, bot, env)) return undefined;
  const holds = () => beat(bot.id, controlLeaseId) || (leaseKey !== bot.id && beat(leaseKey, controlLeaseId));
  return holds() ? holds : undefined;
}

export async function neoLocalVmFallback(
  status: ContainerComputerStatus,
  cfg: AppConfig,
  dataDir: string,
  bot: NeoScreenBotInput | null = null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ContainerComputerStatus> {
  if (status.ready || (bot && usesAttachedChrome(cfg, bot.browserProfile))) return status;
  const screen = resolveNeoVmScreen(cfg, dataDir, bot, env);
  if (!screen || !(await cachedProbe(screen.host, screen.port))) return status;
  return {
    ...status,
    image: true,
    imageMatches: true,
    managed: true,
    container: "running",
    network: "loopback",
    security: "hardened",
    persistence: "durable",
    desktopReady: true,
    desktop_error: null,
    stopped_at: null,
    resumable: false,
    create_supported: false,
    ready: true,
    problem: null,
    driver_version: BROWSEROS_NEO_PIN.version,
    container_name: "omb-computer-neo",
    target_key: NEO_DESKTOP_TARGET_KEY,
    viewer_port: screen.port,
    viewer_url: desktopViewerUrl("local/neo"),
  };
}

export async function neoVmScreenshot(
  cfg: AppConfig,
  dataDir: string,
  bot: NeoScreenBotInput | null = null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (bot && usesAttachedChrome(cfg, bot.browserProfile)) {
    throw Object.assign(new Error("The Local VM is not ready"), { status: 409 });
  }
  const route = resolveNeoRoute(bot, cfg, dataDir, env);
  if (route.kind !== "proxy" || !route.screen || !(await cachedProbe(route.screen.host, route.screen.port))) {
    throw Object.assign(new Error("The Local VM is not ready"), { status: 409 });
  }
  const partition = bot?.browserProfile && bot.browserProfile !== "guest"
    ? browserProfilePartitionTarget(cfg, bot.browserProfile)?.partitionId ?? ""
    : "";
  const session = bot ? browserSessionId(bot.id, partition) : "omb-vm-preview";
  const reply = await forwardNeoHttpProxy(
    route.endpoint,
    route.token,
    session,
    { command: "screenshot", format: "jpeg", quality: 80 },
    AbortSignal.timeout(15_000),
  );
  if (reply.body.ok !== true || typeof reply.body.data !== "string" || reply.body.data.length === 0) {
    throw Object.assign(
      new Error(typeof reply.body.error === "string" ? reply.body.error : "Could not capture the BrowserOS neo VM screen"),
      { status: 502 },
    );
  }
  const mime = reply.body.mimeType === "image/png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${reply.body.data}`;
}
