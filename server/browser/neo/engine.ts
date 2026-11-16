import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scrubHeldSecrets } from "../../../shared/redact.ts";
import { BrowserLanes } from "../../browser-lane.ts";
import { BROWSER_CALL_DEFAULTS, BROWSER_CONTROL_REFUSAL } from "../../browser-runtime.ts";
import { sanitizeUrl, scrubBrowserResult } from "../../browser-tool-shape.ts";
import type { AppConfig } from "../../config.ts";
import type { FillLoginDeps } from "../../login-fill.ts";
import { errorResult, pageLabel, shapeResult, snapshotText, textResult, withParts, type ToolResult } from "../shape.ts";
import { parseToolCall, RESTART_TOOL, targetOf, TOOL_LIST, type ToolCall } from "../tools.ts";
import { forwardBoatNeoCommand } from "./boat.ts";
import { forwardNeoHttpProxy } from "./client.ts";
import { resolveNeoRoute, type NeoRoute, type NeoRouteBotInput } from "./config.ts";
import { NeoLive, type NeoLiveBackend } from "./live.ts";
import { BROWSEROS_NEO_PIN } from "./pins.ts";

/** Spawn-spec marker routing a browser session to BrowserOS neo instead of a local binary. */
export const NEO_ENGINE = "omb-neo";

export interface NeoTarget {
  readonly session: string;
  readonly botId: string;
}

export function neoTarget(session: string, spec: { command: string; args?: readonly string[] } | undefined): NeoTarget | null {
  return spec?.command === NEO_ENGINE ? { session, botId: spec.args?.[0] ?? "" } : null;
}

/** Browser tools exposed on BrowserOS neo; arbitrary JS execution and host file uploads are excluded by security design. */
export const NEO_TOOL_LIST = TOOL_LIST.filter(
  (tool) => tool.name !== "agent_browser_eval" && tool.name !== "agent_browser_upload",
);

const LANE_BUSY = "Your previous browser call is still running; wait for it to finish, then call again.";
const EVAL_REFUSAL =
  "BrowserOS neo runs behind a narrowed proxy that disables arbitrary page JavaScript (agent_browser_eval). Read the page with agent_browser_snapshot or agent_browser_read, or act with refs.";
const UPLOAD_REFUSAL =
  "BrowserOS neo runs in an isolated environment and does not accept direct host file uploads via agent_browser_upload.";
const SELECTOR_ACT_REFUSAL =
  "BrowserOS neo acts on element refs from agent_browser_snapshot (such as e12) or x/y viewport coordinates rather than CSS selectors. Take a snapshot first and pass ref.";

export interface NeoBrowserEngineOptions {
  readonly cfg: AppConfig;
  readonly dataDir: string;
  readonly env?: NodeJS.ProcessEnv;
  botOf(botId: string): NeoRouteBotInput | null | undefined;
  onCloudUsed?(owner: string): void;
  scrub?(text: string): string;
}

interface SessionRecord {
  botId: string;
  activeCalls: number;
  holder: string | null;
  controllingViewer: string | null;
  openedOnce: boolean;
  lastUsed: number;
}

function normalizeHttpUrl(raw: string): { kind: "blank" } | { kind: "url"; url: string } | { kind: "error"; error: string } {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "about:blank") return { kind: "blank" };
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { kind: "error", error: "BrowserOS neo opens HTTP and HTTPS addresses only." };
    }
    if (parsed.username || parsed.password) {
      return { kind: "error", error: "BrowserOS neo refuses URLs with embedded credentials." };
    }
    return { kind: "url", url: parsed.toString() };
  } catch {
    return { kind: "error", error: `Invalid URL: ${trimmed.slice(0, 120)}` };
  }
}

function formatActFailure(reply: Record<string, unknown>): ToolResult {
  const base = typeof reply.error === "string" && reply.error ? reply.error : "The browser action failed.";
  if (reply.uncertain === true) {
    const done = typeof reply.completed === "number" ? reply.completed : 0;
    return errorResult(
      `${base} (${done} step(s) completed before the error and the outcome is uncertain; check the page with agent_browser_snapshot before repeating this action.)`,
    );
  }
  return errorResult(base);
}

function formatSnapshotReply(reply: Record<string, unknown>, prefix?: string): ToolResult {
  if (reply.ok !== true) return formatActFailure(reply);
  const text = snapshotText({
    tab: "t1",
    url: typeof reply.url === "string" && reply.url ? reply.url : "about:blank",
    title: typeof reply.title === "string" ? reply.title : "",
    tree: typeof reply.tree === "string" ? reply.tree : "",
    truncated: reply.truncated === true,
    frames: 1,
  });
  return prefix ? textResult(`${prefix}\n${text}`) : textResult(text);
}

function normalizePressKey(key: string, modifiers?: readonly string[]): string {
  // BrowserOS neo runs on Linux Chromium, so ControlOrMeta maps to Control.
  const mappedKey = key.replace(/\bControlOrMeta\b/g, "Control");
  if (!modifiers || modifiers.length === 0) return mappedKey;
  const mods = modifiers.map((mod) => (mod === "ControlOrMeta" ? "Control" : mod));
  return [...mods, mappedKey].join("+");
}

export class NeoBrowserEngine implements NeoLiveBackend {
  readonly live: NeoLive;
  readonly #options: NeoBrowserEngineOptions;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #lanes = new BrowserLanes();
  readonly #scrub: (text: string) => string;

  constructor(options: NeoBrowserEngineOptions) {
    this.#options = options;
    this.#scrub = options.scrub ?? scrubHeldSecrets;
    this.live = new NeoLive(this);
  }

  spec(session: string, botId: string): { command: string; args: string[]; env: Record<string, string> } {
    const existing = this.#sessions.get(session);
    if (existing) {
      existing.botId = botId;
    } else {
      this.#sessions.set(session, {
        botId,
        activeCalls: 0,
        holder: null,
        controllingViewer: null,
        openedOnce: false,
        lastUsed: Date.now(),
      });
    }
    return { command: NEO_ENGINE, args: [botId], env: {} };
  }

  #ensureSession(target: NeoTarget): SessionRecord {
    let state = this.#sessions.get(target.session);
    if (!state) {
      state = {
        botId: target.botId,
        activeCalls: 0,
        holder: null,
        controllingViewer: null,
        openedOnce: false,
        lastUsed: Date.now(),
      };
      this.#sessions.set(target.session, state);
    } else if (target.botId) {
      state.botId = target.botId;
    }
    return state;
  }

  knownSession(session: string): boolean {
    return this.#sessions.has(session);
  }

  runs(session: string): boolean {
    return this.#sessions.get(session)?.openedOnce === true;
  }

  heldBy(session: string): string | null {
    return this.#sessions.get(session)?.holder ?? null;
  }

  controllingViewer(session: string): string | null {
    return this.#sessions.get(session)?.controllingViewer ?? null;
  }

  working(session: string): boolean {
    const state = this.#sessions.get(session);
    return Boolean(state && (state.activeCalls > 0 || state.holder !== null || this.#lanes.held(session)));
  }

  interrupted(_session: string): boolean {
    return false;
  }

  interruptedCount(): number {
    return 0;
  }

  takeControl(session: string, person: string, viewerId: string): boolean {
    const state = this.#sessions.get(session);
    if (!state) return false;
    if (state.holder !== null && state.holder !== person) return false;
    state.holder = person;
    state.controllingViewer = viewerId;
    return true;
  }

  releaseControl(session: string, person: string, viewerId?: string): void {
    const state = this.#sessions.get(session);
    if (!state || state.holder !== person) return;
    if (viewerId && state.controllingViewer && state.controllingViewer !== viewerId) return;
    state.holder = null;
    state.controllingViewer = null;
  }

  handBack(session: string): void {
    const state = this.#sessions.get(session);
    if (!state) return;
    state.holder = null;
    state.controllingViewer = null;
  }

  routeFor(botId: string): NeoRoute {
    const bot = botId ? (this.#options.botOf(botId) ?? { id: botId }) : null;
    return resolveNeoRoute(bot, this.#options.cfg, this.#options.dataDir, this.#options.env);
  }

  async command(session: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const state = this.#sessions.get(session);
    const botId = state?.botId ?? "";
    const route = this.routeFor(botId);
    if (route.kind === "disabled") {
      return { ok: false, error: "BrowserOS neo is not enabled for this bot." };
    }
    if (route.kind === "misconfigured") {
      return { ok: false, error: route.reason };
    }
    if (state) {
      state.lastUsed = Date.now();
      if (payload.command !== "close") state.openedOnce = true;
    }
    if (route.kind === "boat") {
      const reply = await forwardBoatNeoCommand(this.#options.cfg, route.owner, session, payload, {
        ownerName: route.ownerName,
        upstreamProxy: route.upstreamProxy,
        onUsed: this.#options.onCloudUsed,
        signal,
      });
      return reply.body;
    }
    const reply = await forwardNeoHttpProxy(route.endpoint, route.token, session, payload, signal);
    return reply.body;
  }

  async agentRpc(
    target: NeoTarget,
    method: "tools/list" | "tools/call",
    params: unknown,
    beforeDispatch?: () => void,
  ): Promise<unknown> {
    if (method === "tools/list") {
      return { tools: NEO_TOOL_LIST.map((tool) => ({ ...tool })) };
    }
    if (method !== "tools/call") throw new Error("Unsupported browser method.");
    const state = this.#ensureSession(target);
    const rawName = (params as { name?: unknown } | null)?.name;
    const toolName = typeof rawName === "string" ? rawName : "browser";
    state.activeCalls += 1;
    try {
      const work = async (): Promise<ToolResult> => {
        beforeDispatch?.();
        if (state.holder !== null && toolName !== RESTART_TOOL) {
          return errorResult(BROWSER_CONTROL_REFUSAL);
        }
        if (toolName === "agent_browser_eval") return errorResult(EVAL_REFUSAL);
        if (toolName === "agent_browser_upload") return errorResult(UPLOAD_REFUSAL);
        const parsed = parseToolCall(rawName, (params as { arguments?: unknown } | null)?.arguments);
        if (!parsed.ok) return errorResult(parsed.error);
        const result = await this.#dispatch(target.session, state, parsed.call);
        return shapeResult(result, parsed.call.name);
      };
      const outcome =
        toolName === RESTART_TOOL
          ? await work()
          : await this.#lanes.run(target.session, work, BROWSER_CALL_DEFAULTS.laneWaitMs);
      return scrubBrowserResult(outcome ?? errorResult(LANE_BUSY), this.#scrub);
    } finally {
      state.activeCalls -= 1;
      state.lastUsed = Date.now();
    }
  }

  async #dispatch(session: string, state: SessionRecord, call: ToolCall): Promise<ToolResult> {
    const route = this.routeFor(state.botId);
    if (route.kind === "disabled") return errorResult("BrowserOS neo is not enabled for this bot.");
    if (route.kind === "misconfigured") return errorResult(route.reason);

    switch (call.name) {
      case "agent_browser_status": {
        const reply = await this.command(session, { command: "status" });
        if (reply.ok !== true) return formatActFailure(reply);
        const url = typeof reply.url === "string" && reply.url ? reply.url : "about:blank";
        const title = typeof reply.title === "string" ? reply.title : "";
        if (call.as === "url") return textResult(sanitizeUrl(url) || url);
        if (call.as === "title") return textResult(title || "(untitled)");
        const backend = route.kind === "boat" ? "cloud desktop" : "VM proxy";
        return textResult(
          [
            `Browser: BrowserOS neo (${backend})`,
            `URL: ${sanitizeUrl(url) || url}`,
            `Title: ${title || "(untitled)"}`,
            `Tabs: t1 (front${reply.adopted === true ? ", visible desktop tab" : ""})`,
            `Control: ${state.holder ? `held by ${state.holder}` : "bot"}`,
          ].join("\n"),
        );
      }
      case "agent_browser_open": {
        if (call.input.url !== undefined) {
          const normalized = normalizeHttpUrl(call.input.url);
          if (normalized.kind === "error") return errorResult(normalized.error);
          if (normalized.kind === "blank") {
            await this.command(session, { command: "close" });
          } else {
            const nav = await this.command(session, { command: "navigate", action: "url", url: normalized.url });
            if (nav.ok !== true) return formatActFailure(nav);
          }
        }
        const snap = await this.command(session, { command: "snapshot" });
        this.live.notifyChanged(session);
        return formatSnapshotReply(snap);
      }
      case "agent_browser_navigate": {
        if (call.input.action) {
          const nav = await this.command(session, { command: "navigate", action: call.input.action });
          if (nav.ok !== true) return formatActFailure(nav);
          this.live.notifyChanged(session);
          return textResult(
            `Navigated (${call.input.action}) to ${pageLabel({
              tab: "t1",
              url: String(nav.url || "about:blank"),
              title: String(nav.title || ""),
            })}. Refs from earlier snapshots are gone; take a snapshot before acting on refs.`,
          );
        }
        if (call.input.url !== undefined) {
          const normalized = normalizeHttpUrl(call.input.url);
          if (normalized.kind === "error") return errorResult(normalized.error);
          if (normalized.kind === "blank") {
            await this.command(session, { command: "close" });
            this.live.notifyChanged(session);
            return textResult("Navigated to t1: about:blank. Refs from earlier snapshots are gone.");
          }
          const nav = await this.command(session, { command: "navigate", action: "url", url: normalized.url });
          if (nav.ok !== true) return formatActFailure(nav);
          this.live.notifyChanged(session);
          return textResult(
            `Navigated to ${pageLabel({
              tab: "t1",
              url: String(nav.url || normalized.url),
              title: String(nav.title || ""),
            })}. Refs from earlier snapshots are gone; take a snapshot before acting on refs.`,
          );
        }
        return errorResult("Pass url or action (back, forward, reload).");
      }
      case "agent_browser_snapshot": {
        const snap = await this.command(session, { command: "snapshot" });
        const base = formatSnapshotReply(snap);
        if (base.isError) return base;
        if (!call.input.includeImage && !call.input.save) return base;
        const format = call.input.save ? "png" : "jpeg";
        const shot = await this.command(session, { command: "screenshot", format, quality: 75 });
        if (shot.ok !== true || typeof shot.data !== "string") return base;
        let savedLine: string | undefined;
        if (call.input.save) {
          const folder = join(this.#options.dataDir, "browser", "neo-screenshots");
          mkdirSync(folder, { recursive: true, mode: 0o700 });
          const filePath = join(folder, `${randomUUID()}.png`);
          writeFileSync(filePath, Buffer.from(shot.data, "base64"), { mode: 0o600 });
          savedLine = `Saved screenshot: ${filePath}`;
        }
        const withSaved = savedLine ? withParts(base, savedLine) : base;
        return call.input.includeImage
          ? {
              ...withSaved,
              content: [
                ...withSaved.content,
                { type: "image", data: shot.data, mimeType: format === "png" ? "image/png" : "image/jpeg" },
              ],
            }
          : withSaved;
      }
      case "agent_browser_read": {
        if (call.input.ref && !call.input.selector) {
          return errorResult(
            "BrowserOS neo agent_browser_read narrows by CSS selector rather than element ref; omit ref to read the page or pass selector.",
          );
        }
        if (call.input.url !== undefined) {
          const normalized = normalizeHttpUrl(call.input.url);
          if (normalized.kind === "error") return errorResult(normalized.error);
          if (normalized.kind === "url") {
            const nav = await this.command(session, { command: "navigate", action: "url", url: normalized.url });
            if (nav.ok !== true) return formatActFailure(nav);
            this.live.notifyChanged(session);
          }
        }
        const offset = call.input.offset ?? 0;
        const maxChars = call.input.maxChars ?? 20_000;
        const read = await this.command(session, {
          command: "read",
          format: "text",
          ...(call.input.selector ? { selector: call.input.selector } : {}),
          offset,
          maxChars,
        });
        if (read.ok !== true) return formatActFailure(read);
        const text = typeof read.text === "string" ? read.text : "";
        const label = pageLabel({
          tab: "t1",
          url: typeof read.url === "string" && read.url ? read.url : "about:blank",
          title: typeof read.title === "string" ? read.title : "",
        });
        const more =
          read.truncated === true
            ? `\n[Truncated at character ${offset + text.length}${typeof read.totalChars === "number" ? ` of ${read.totalChars}` : ""}; pass offset=${offset + text.length} to read on.]`
            : "";
        return textResult(`Page ${label}.\n${text}${more}`);
      }
      case "agent_browser_screenshot": {
        const shot = await this.command(session, {
          command: "screenshot",
          format: "png",
          fullPage: call.input.fullPage === true,
        });
        if (shot.ok !== true || typeof shot.data !== "string") return formatActFailure(shot);
        const label = pageLabel({
          tab: "t1",
          url: typeof shot.url === "string" && shot.url ? shot.url : "about:blank",
          title: typeof shot.title === "string" ? shot.title : "",
        });
        return {
          content: [
            { type: "text", text: `Screenshot of ${label} (1:1 CSS pixels).` },
            { type: "image", data: shot.data, mimeType: typeof shot.mimeType === "string" ? shot.mimeType : "image/png" },
          ],
        };
      }
      case "agent_browser_click": {
        const target = targetOf(call.input);
        if (typeof target === "string") return errorResult(target);
        if ("selector" in target) return errorResult(SELECTOR_ACT_REFUSAL);
        const action =
          "ref" in target
            ? {
                kind: "click",
                ref: target.ref,
                ...(call.input.button ? { button: call.input.button } : {}),
                ...(call.input.clickCount ? { clickCount: call.input.clickCount } : {}),
              }
            : {
                kind: "click_at",
                x: target.x,
                y: target.y,
                ...(call.input.button ? { button: call.input.button } : {}),
                ...(call.input.clickCount ? { clickCount: call.input.clickCount } : {}),
              };
        const reply = await this.command(session, { command: "act", actions: [action] });
        this.live.notifyChanged(session);
        return formatSnapshotReply(reply);
      }
      case "agent_browser_fill": {
        if (call.input.selector && !call.input.ref) return errorResult(SELECTOR_ACT_REFUSAL);
        if (!call.input.ref) return errorResult("Name the field to fill with ref (from a snapshot).");
        const actions: Array<Record<string, unknown>> = [{ kind: "fill", ref: call.input.ref, text: call.input.text }];
        if (call.input.submit) actions.push({ kind: "press", key: "Enter" });
        const reply = await this.command(session, { command: "act", actions });
        this.live.notifyChanged(session);
        return formatSnapshotReply(reply);
      }
      case "agent_browser_type": {
        if (call.input.selector && !call.input.ref) return errorResult(SELECTOR_ACT_REFUSAL);
        const actions: Array<Record<string, unknown>> = [];
        if (call.input.ref && call.input.clear) {
          actions.push({ kind: "fill", ref: call.input.ref, text: "" });
        }
        actions.push({
          kind: "type",
          ...(call.input.ref ? { ref: call.input.ref } : {}),
          text: call.input.text,
        });
        const reply = await this.command(session, { command: "act", actions });
        this.live.notifyChanged(session);
        return formatSnapshotReply(reply);
      }
      case "agent_browser_press": {
        const key = normalizePressKey(call.input.key, call.input.modifiers);
        const reply = await this.command(session, { command: "act", actions: [{ kind: "press", key }] });
        this.live.notifyChanged(session);
        return formatSnapshotReply(reply);
      }
      case "agent_browser_select": {
        if (call.input.selector && !call.input.ref) return errorResult(SELECTOR_ACT_REFUSAL);
        if (!call.input.ref) return errorResult("Name the <select> element with ref (from a snapshot).");
        const actions = call.input.values.slice(0, 24).map((value) => ({ kind: "select", ref: call.input.ref, value }));
        const reply = await this.command(session, { command: "act", actions });
        this.live.notifyChanged(session);
        return formatSnapshotReply(reply);
      }
      case "agent_browser_check": {
        if (call.input.selector && !call.input.ref) return errorResult(SELECTOR_ACT_REFUSAL);
        if (!call.input.ref) return errorResult("Name the checkbox or radio option with ref (from a snapshot).");
        const kind = call.input.checked === false ? "uncheck" : "check";
        const reply = await this.command(session, { command: "act", actions: [{ kind, ref: call.input.ref }] });
        this.live.notifyChanged(session);
        return formatSnapshotReply(reply);
      }
      case "agent_browser_hover": {
        const target = targetOf(call.input);
        if (typeof target === "string") return errorResult(target);
        if ("selector" in target) return errorResult(SELECTOR_ACT_REFUSAL);
        const action = "ref" in target ? { kind: "hover", ref: target.ref } : { kind: "hover_at", x: target.x, y: target.y };
        const reply = await this.command(session, { command: "act", actions: [action] });
        this.live.notifyChanged(session);
        return formatSnapshotReply(reply);
      }
      case "agent_browser_drag": {
        const { from, to } = call.input;
        if (from.ref && to.ref) {
          const reply = await this.command(session, {
            command: "act",
            actions: [{ kind: "drag", ref: from.ref, targetRef: to.ref }],
          });
          this.live.notifyChanged(session);
          return formatSnapshotReply(reply);
        }
        if (from.x !== undefined && from.y !== undefined && to.x !== undefined && to.y !== undefined) {
          const reply = await this.command(session, {
            command: "act",
            actions: [{ kind: "drag_at", startX: from.x, startY: from.y, endX: to.x, endY: to.y }],
          });
          this.live.notifyChanged(session);
          return formatSnapshotReply(reply);
        }
        return errorResult("BrowserOS neo drag requires either from.ref + to.ref or from.{x,y} + to.{x,y}.");
      }
      case "agent_browser_scroll": {
        if (call.input.selector && !call.input.ref) return errorResult(SELECTOR_ACT_REFUSAL);
        const dx = call.input.dx ?? 0;
        const dy = call.input.dy ?? (call.input.dx === undefined ? 600 : 0);
        const horizontal = Math.abs(dx) > Math.abs(dy);
        const dist = horizontal ? dx : dy;
        const direction = horizontal ? (dist >= 0 ? "right" : "left") : dist >= 0 ? "down" : "up";
        const amount = Math.max(1, Math.min(200, Math.round(Math.abs(dist) / 100) || 1));
        const reply = await this.command(session, {
          command: "act",
          actions: [{ kind: "scroll", direction, amount, ...(call.input.ref ? { ref: call.input.ref } : {}) }],
        });
        this.live.notifyChanged(session);
        return formatSnapshotReply(reply);
      }
      case "agent_browser_wait": {
        const budget = Math.min(20_000, call.input.timeoutMs ?? 15_000);
        if (call.input.ms !== undefined && call.input.ms > 0) {
          let remaining = Math.min(60_000, call.input.ms);
          while (remaining > 0) {
            const step = Math.min(15_000, remaining);
            const waited = await this.command(session, { command: "wait", for: "time", value: step });
            if (waited.ok !== true) return formatActFailure(waited);
            remaining -= step;
          }
        }
        if (call.input.text) {
          const waited = await this.command(session, {
            command: "wait",
            for: "text",
            value: call.input.text,
            timeout: budget,
          });
          if (waited.ok !== true) return formatActFailure(waited);
          if (waited.matched === false) return errorResult(`Timed out waiting for text ${JSON.stringify(call.input.text)}.`);
        }
        if (call.input.selector && !call.input.gone) {
          const waited = await this.command(session, {
            command: "wait",
            for: "selector",
            value: call.input.selector,
            timeout: budget,
          });
          if (waited.ok !== true) return formatActFailure(waited);
          if (waited.matched === false) return errorResult(`Timed out waiting for selector ${call.input.selector}.`);
        }
        if (call.input.urlIncludes) {
          const until = Date.now() + budget;
          let matched = false;
          while (Date.now() < until) {
            const st = await this.command(session, { command: "status" });
            if (st.ok === true && typeof st.url === "string" && st.url.includes(call.input.urlIncludes)) {
              matched = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 350));
          }
          if (!matched) return errorResult(`Timed out waiting for URL to include ${JSON.stringify(call.input.urlIncludes)}.`);
        }
        const status = await this.command(session, { command: "status" });
        if (status.ok !== true) return formatActFailure(status);
        return textResult(
          `Wait satisfied on ${pageLabel({
            tab: "t1",
            url: String(status.url || "about:blank"),
            title: String(status.title || ""),
          })}.`,
        );
      }
      case "agent_browser_dialog": {
        const action = call.input.accept
          ? { kind: "dialog_accept", ...(call.input.promptText !== undefined ? { text: call.input.promptText } : {}) }
          : { kind: "dialog_dismiss" };
        const reply = await this.command(session, { command: "act", actions: [action] });
        this.live.notifyChanged(session);
        return formatSnapshotReply(reply);
      }
      case "agent_browser_tabs": {
        if (call.input.action === "close") {
          await this.command(session, { command: "close" });
          state.openedOnce = false;
          this.live.notifyChanged(session);
          return textResult("Closed tab t1 and reset the BrowserOS neo session to about:blank.");
        }
        if (call.input.action === "new" && call.input.url) {
          const normalized = normalizeHttpUrl(call.input.url);
          if (normalized.kind === "error") return errorResult(normalized.error);
          if (normalized.kind === "url") {
            const nav = await this.command(session, { command: "navigate", action: "url", url: normalized.url });
            if (nav.ok !== true) return formatActFailure(nav);
            this.live.notifyChanged(session);
          }
        }
        const status = await this.command(session, { command: "status" });
        if (status.ok !== true) return formatActFailure(status);
        const label = pageLabel({
          tab: "t1",
          url: String(status.url || "about:blank"),
          title: String(status.title || ""),
        });
        return textResult(
          `Tabs (BrowserOS neo isolates one tab t1 per session):\n* ${label}`,
        );
      }
      case "agent_browser_close": {
        await this.command(session, { command: "close" });
        state.openedOnce = false;
        this.live.closeForSession(session);
        return textResult("Closed the BrowserOS neo session tab; saved sign-ins in BrowserOS neo are kept.");
      }
      case RESTART_TOOL: {
        if (state.holder !== null) return errorResult(BROWSER_CONTROL_REFUSAL);
        await this.command(session, { command: "close" });
        state.openedOnce = false;
        this.live.closeForSession(session);
        return textResult(
          "BrowserOS neo session reset to a fresh blank tab; saved sign-ins are kept. Open the page you need again and check whether an interrupted action already took effect before repeating it.",
        );
      }
      case "agent_browser_eval":
        return errorResult(EVAL_REFUSAL);
      case "agent_browser_upload":
        return errorResult(UPLOAD_REFUSAL);
    }
  }

  async previewFrame(session: string): Promise<{ png: string; format: "jpeg" }> {
    const state = this.#sessions.get(session);
    if (!state || !state.openedOnce) throw new Error("the browser has no open page to picture");
    if (state.activeCalls > 0 || this.#lanes.held(session)) throw new Error("The browser is busy with an agent action.");
    if (state.holder !== null) throw new Error("a person holds the browser");
    const shot = await this.command(session, { command: "screenshot", format: "jpeg", quality: 75 }, AbortSignal.timeout(12_000));
    if (shot.ok !== true || typeof shot.data !== "string") {
      throw new Error(typeof shot.error === "string" ? shot.error : "could not capture preview frame");
    }
    return { png: shot.data, format: "jpeg" };
  }

  async withSecretInput<T>(target: NeoTarget, fn: () => Promise<T>): Promise<T> {
    this.#ensureSession(target);
    const outcome = await this.#lanes.run(target.session, fn, BROWSER_CALL_DEFAULTS.laneWaitMs);
    if (outcome === null) throw new Error(LANE_BUSY);
    return outcome;
  }

  loginDeps(target: NeoTarget): Pick<FillLoginDeps, "engine" | "insertText" | "press" | "click"> {
    this.#ensureSession(target);
    return {
      engine: async (args) => {
        if (args[0] === "get" && args[1] === "url") {
          const status = await this.command(target.session, { command: "status" });
          return status.ok === true && typeof status.url === "string" ? { url: status.url } : null;
        }
        return null;
      },
      insertText: async (text) => {
        const res = await this.command(target.session, {
          command: "act",
          skipSnapshot: true,
          actions: [{ kind: "type", text }],
        });
        if (res.ok !== true) throw new Error(typeof res.error === "string" ? res.error : "Could not type into BrowserOS neo.");
      },
      press: async (key) => {
        const res = await this.command(target.session, {
          command: "act",
          skipSnapshot: true,
          actions: [{ kind: "press", key }],
        });
        if (res.ok !== true) throw new Error(typeof res.error === "string" ? res.error : "Could not press key in BrowserOS neo.");
      },
      click: async () => {
        throw new Error("BrowserOS neo clicks by snapshot ref rather than CSS selector; use request_sign_in for interactive sign-in.");
      },
    };
  }

  async closeUnused(session: string): Promise<boolean> {
    const state = this.#sessions.get(session);
    if (!state || !state.openedOnce || this.working(session)) return false;
    await this.close(session);
    return true;
  }

  async close(session: string): Promise<void> {
    const state = this.#sessions.get(session);
    this.live.closeForSession(session);
    if (!state) return;
    const wasOpen = state.openedOnce;
    state.openedOnce = false;
    state.holder = null;
    state.controllingViewer = null;
    if (wasOpen) {
      await this.command(session, { command: "close" }, AbortSignal.timeout(6_000)).catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    this.live.closeAll();
    const sessions = [...this.#sessions.keys()];
    await Promise.all(sessions.map((session) => this.close(session)));
  }

  summary(): { kind: "engine"; version: string; chrome: string } | { kind: "unavailable"; reason: string } {
    const route = resolveNeoRoute(null, this.#options.cfg, this.#options.dataDir, this.#options.env);
    if (route.kind === "misconfigured") {
      return { kind: "unavailable", reason: route.reason };
    }
    const target = route.kind === "boat" ? "cloud desktop" : route.kind === "proxy" ? "VM proxy" : "configured";
    return {
      kind: "engine",
      version: `browseros-neo/${BROWSEROS_NEO_PIN.version}`,
      chrome: `BrowserOS neo ${BROWSEROS_NEO_PIN.version} (${target})`,
    };
  }
}
