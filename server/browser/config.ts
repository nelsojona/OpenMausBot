// `browserEngine` in config.json.
import { z } from "zod";

import { browserEgressConfigSchema, type BrowserEgressConfig } from "./egress/policy.ts";

const CDP_PORT = /^[0-9]{1,5}$/;
const CDP_URL = /^(https?|wss?):\/\/\S+$/i;

/** agent-browser's `--cdp` takes a bare port or an http(s)/ws(s) DevTools URL. */
export function isValidCdpTarget(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (CDP_PORT.test(value)) {
    const port = Number(value);
    return port >= 1 && port <= 65535;
  }
  return CDP_URL.test(value);
}

export type BrowserEngineKind = "agent-browser" | "chrome" | "browseros-neo";

export const browserNeoScreenConfigSchema = z.object({
  vnc: z.string().trim().max(256).optional(),
  password: z.string().trim().max(512).optional(),
  passwordFile: z.string().trim().max(1024).optional(),
});

export interface BrowserNeoScreenConfig {
  vnc?: string;
  password?: string;
  passwordFile?: string;
}

export const browserNeoConfigSchema = z.object({
  url: z.string().trim().max(2048).optional(),
  token: z.string().trim().max(512).optional(),
  tokenFile: z.string().trim().max(1024).optional(),
  screen: browserNeoScreenConfigSchema.optional(),
  optOutBots: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  cloudDesktop: z.boolean().optional(),
});

export interface BrowserNeoConfig {
  url?: string;
  token?: string;
  tokenFile?: string;
  screen?: BrowserNeoScreenConfig;
  optOutBots?: string[];
  cloudDesktop?: boolean;
}

/** `attachCdpUrl`: a running Chrome that My Chrome profiles attach to. Config only, never env: the ambient environment must not redirect a bot's browser. */
export const browserEngineConfigSchema = z.object({
  attachCdpUrl: z.string().trim().max(2048).refine((value) => value === "" || isValidCdpTarget(value),
    { message: "browserEngine.attachCdpUrl must be a CDP port (1-65535) or an http(s)/ws(s) URL" }).optional(),
  idleTimeoutMinutes: z.number().int().min(1).max(60).optional(), // an unused browser closes after this; 10 when unset, 3 on MausBot Cloud
  egress: browserEgressConfigSchema.optional(),
  /** "chrome" runs the bots' browsers on OpenMausBot's own Chrome driver; "browseros-neo" routes through the BrowserOS neo proxy; agent-browser is the default. */
  engine: z.enum(["agent-browser", "chrome", "browseros-neo"]).optional(),
  /** "pane" shows the Chrome engine's browser on the desktop app as a real page the person uses directly, an early test; streamed when unset. */
  surface: z.enum(["stream", "pane"]).optional(),
  /** On a Linux server with Xvnc, the new engine's Chrome runs with its window on a private display that the browser panel
   * shows and a person drives as a remote desktop. Off by default. */
  cloudDisplay: z.boolean().optional(),
  /** The user agent the desktop pane presents: Electron's own ("native", the default) or without its Electron token ("cleaned"). */
  paneIdentity: z.enum(["native", "cleaned"]).optional(),
  neo: browserNeoConfigSchema.optional(),
});

export interface BrowserEngineConfig {
  attachCdpUrl?: string;
  idleTimeoutMinutes?: number;
  egress?: BrowserEgressConfig;
  engine?: BrowserEngineKind;
  surface?: "stream" | "pane";
  cloudDisplay?: boolean;
  paneIdentity?: "native" | "cleaned";
  neo?: BrowserNeoConfig;
}

export function browserOsNeoEnabled(cfg: {
  features?: { browserOsNeo?: boolean };
  browserEngine?: BrowserEngineConfig;
}): boolean {
  if (cfg.features?.browserOsNeo === false) return false;
  return cfg.features?.browserOsNeo === true || cfg.browserEngine?.engine === "browseros-neo";
}

export function browserEngineKind(cfg: {
  features?: { browserOsNeo?: boolean };
  browserEngine?: BrowserEngineConfig;
}): BrowserEngineKind {
  if (browserOsNeoEnabled(cfg)) return "browseros-neo";
  return cfg.browserEngine?.engine === "chrome" ? "chrome" : "agent-browser";
}

/** The desktop pane needs the Chrome engine too: it is that engine's browser, shown natively. */
export function browserPaneWanted(cfg: { browserEngine?: BrowserEngineConfig }): boolean {
  return browserEngineKind(cfg) === "chrome" && cfg.browserEngine?.surface === "pane";
}

/** The bots' browsers should run on a display a person sees: asked for in config, on the new engine, on a server. */
export function cloudDisplayWanted(cfg: { browserEngine?: BrowserEngineConfig }, host: "desktop" | "server" | "container", platform: NodeJS.Platform = process.platform): boolean {
  return cfg.browserEngine?.cloudDisplay === true && browserEngineKind(cfg) === "chrome" && host !== "desktop" && platform === "linux";
}
