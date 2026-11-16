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
  neo: browserNeoConfigSchema.optional(),
});

export interface BrowserEngineConfig {
  attachCdpUrl?: string;
  idleTimeoutMinutes?: number;
  egress?: BrowserEgressConfig;
  engine?: BrowserEngineKind;
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
