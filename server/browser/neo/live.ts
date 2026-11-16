import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { BROWSER_HELD_ELSEWHERE } from "../../../shared/browser-held.ts";
import { BROWSER_WAITING, BrowserLiveError, parseBrowserLiveAction } from "../../browser-live.ts";
import { displayUrl, type LiveOpenOptions } from "../viewers/live-v1.ts";

const MAX_FRAME = 3 * 1024 * 1024;
const MAX_BUFFER = 4 * 1024 * 1024;
const HEARTBEAT_MS = 10_000;
const FRAME_POLL_MS = 1_500;
const VIEWERS_TOTAL = 8;
const VIEWERS_PER_SESSION = 2;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

export interface NeoLiveBackend {
  knownSession(session: string): boolean;
  heldBy(session: string): string | null;
  takeControl(session: string, person: string, viewerId: string): boolean;
  releaseControl(session: string, person: string, viewerId?: string): void;
  handBack(session: string): void;
  controllingViewer(session: string): string | null;
  working(session: string): boolean;
  command(session: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

interface NeoViewer {
  readonly id: string;
  readonly botId: string;
  readonly session: string;
  readonly owner: string;
  readonly person: string;
  readonly isCurrent: () => boolean;
  readonly res: ServerResponse;
  width: number;
  height: number;
  closed: boolean;
  blocked: boolean;
  ready: boolean;
  seq: number;
  sentAt: number | null;
  sentSeq: number | null;
  pendingFrame: { data: string; url: string; title: string } | null;
  inFlightPoll: boolean;
  pendingActions: number;
  restarting: boolean;
  lastUrl: string;
  heartbeat?: ReturnType<typeof setInterval>;
  pollTimer?: ReturnType<typeof setInterval>;
  drainTimer?: ReturnType<typeof setTimeout>;
}

export class NeoLive {
  readonly #backend: NeoLiveBackend;
  readonly #viewers = new Map<string, NeoViewer>();

  constructor(backend: NeoLiveBackend) {
    this.#backend = backend;
  }

  has(viewerId: string): boolean {
    return this.#viewers.has(viewerId);
  }

  #current(viewer: NeoViewer): boolean {
    try {
      return !viewer.closed && !viewer.res.destroyed && !viewer.res.writableEnded && viewer.isCurrent();
    } catch {
      return false;
    }
  }

  #startEvents(viewer: NeoViewer): void {
    if (viewer.res.headersSent) return;
    viewer.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    viewer.res.flushHeaders();
  }

  #send(viewer: NeoViewer, message: Record<string, unknown>): void {
    if (!this.#current(viewer)) {
      this.#close(viewer);
      return;
    }
    if (!viewer.res.headersSent || viewer.blocked) return;
    if (viewer.res.writableLength > MAX_BUFFER) {
      this.#close(viewer);
      return;
    }
    const { type, ...data } = message;
    let written: boolean;
    try {
      written = viewer.res.write(`event: ${String(type)}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.#close(viewer);
      return;
    }
    if (!written) {
      viewer.blocked = true;
      viewer.drainTimer = setTimeout(() => this.#close(viewer), HEARTBEAT_MS);
      viewer.drainTimer.unref?.();
      viewer.res.once("drain", () => {
        viewer.blocked = false;
        clearTimeout(viewer.drainTimer);
        this.#flushFrame(viewer);
      });
    }
  }

  #controlState(viewer: NeoViewer): { held: boolean; owned: boolean; controlling: boolean } {
    const holder = this.#backend.heldBy(viewer.session);
    const held = holder !== null;
    const owned = holder === viewer.person;
    const controlling = owned && this.#backend.controllingViewer(viewer.session) === viewer.id;
    return { held, owned, controlling };
  }

  #sendControl(viewer: NeoViewer): void {
    const state = this.#controlState(viewer);
    this.#send(viewer, { type: "control", ...state });
  }

  notifyControl(session: string): void {
    for (const viewer of this.#viewers.values()) {
      if (viewer.session === session) this.#sendControl(viewer);
    }
  }

  notifyChanged(session: string): void {
    for (const viewer of this.#viewers.values()) {
      if (viewer.session === session) void this.#capture(viewer);
    }
  }

  #flushFrame(viewer: NeoViewer): void {
    const frame = viewer.pendingFrame;
    if (!frame || viewer.sentSeq !== null || viewer.blocked || !this.#current(viewer)) return;
    viewer.pendingFrame = null;
    const seq = ++viewer.seq;
    viewer.sentSeq = seq;
    viewer.sentAt = Date.now();
    const safeUrl = displayUrl(frame.url);
    if (safeUrl && safeUrl !== viewer.lastUrl) {
      viewer.lastUrl = safeUrl;
      this.#send(viewer, { type: "url", url: safeUrl });
      this.#send(viewer, {
        type: "tabs",
        tabs: [{ tabId: "t1", title: (frame.title || safeUrl).slice(0, 512), url: safeUrl, active: true }],
      });
    }
    this.#send(viewer, {
      type: "frame",
      seq,
      data: frame.data,
      format: "jpeg",
      metadata: {
        deviceWidth: viewer.width,
        deviceHeight: viewer.height,
        offsetTop: 0,
        pageScaleFactor: 1,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        timestamp: Date.now() / 1000,
      },
    });
  }

  async #capture(viewer: NeoViewer): Promise<void> {
    if (!viewer.ready || viewer.closed || viewer.inFlightPoll || !this.#current(viewer)) return;
    viewer.inFlightPoll = true;
    try {
      const reply = await this.#backend.command(
        viewer.session,
        { command: "screenshot", format: "jpeg", quality: 70 },
        AbortSignal.timeout(12_000),
      );
      if (reply.ok !== true || typeof reply.data !== "string") return;
      if (Buffer.byteLength(reply.data, "base64") > MAX_FRAME) return;
      viewer.pendingFrame = {
        data: reply.data,
        url: typeof reply.url === "string" ? reply.url : "about:blank",
        title: typeof reply.title === "string" ? reply.title : "",
      };
      this.#flushFrame(viewer);
    } catch {
    } finally {
      viewer.inFlightPoll = false;
    }
  }

  async open(options: LiveOpenOptions): Promise<void> {
    const sessionViewers = [...this.#viewers.values()].filter((v) => v.session === options.session).length;
    if (this.#viewers.size >= VIEWERS_TOTAL || sessionViewers >= VIEWERS_PER_SESSION) {
      throw new BrowserLiveError("Too many browser views are open. Close another browser panel first.", 429);
    }
    if (!this.#backend.knownSession(options.session)) {
      throw new BrowserLiveError("The browser session is not registered yet.", 503);
    }
    const viewer: NeoViewer = {
      id: randomUUID(),
      botId: options.botId,
      session: options.session,
      owner: options.owner,
      person: options.person ?? options.owner,
      isCurrent: options.isCurrent,
      res: options.res,
      width: options.size?.width ? Math.round(options.size.width) : DEFAULT_WIDTH,
      height: options.size?.height ? Math.round(options.size.height) : DEFAULT_HEIGHT,
      closed: false,
      blocked: false,
      ready: false,
      seq: 0,
      sentAt: null,
      sentSeq: null,
      pendingFrame: null,
      inFlightPoll: false,
      pendingActions: 0,
      restarting: false,
      lastUrl: "",
    };
    if (!this.#current(viewer)) throw new BrowserLiveError("This browser view is no longer available.", 409);
    options.res.once("close", () => this.#close(viewer));
    options.res.once("error", () => this.#close(viewer));

    const waiting = setTimeout(() => {
      if (viewer.ready || viewer.closed) return;
      this.#startEvents(viewer);
      this.#send(viewer, BROWSER_WAITING);
    }, 4_000);
    waiting.unref?.();

    try {
      const status = await this.#backend.command(viewer.session, { command: "status" }, AbortSignal.timeout(20_000));
      clearTimeout(waiting);
      if (status.ok !== true) {
        throw new BrowserLiveError(
          typeof status.error === "string" ? status.error : "The BrowserOS neo stream could not start.",
          503,
        );
      }
      if (!this.#current(viewer)) {
        this.#close(viewer);
        return;
      }
      this.#viewers.set(viewer.id, viewer);
      this.#startEvents(viewer);
      viewer.ready = true;
      this.#send(viewer, { type: "ready", viewerId: viewer.id });
      this.#send(viewer, {
        type: "status",
        connected: true,
        screencasting: true,
        viewportWidth: viewer.width,
        viewportHeight: viewer.height,
      });
      const safeUrl = displayUrl(status.url) || "about:blank";
      viewer.lastUrl = safeUrl;
      this.#send(viewer, { type: "url", url: safeUrl });
      this.#send(viewer, {
        type: "tabs",
        tabs: [{ tabId: "t1", title: String(status.title ?? "").slice(0, 512), url: safeUrl, active: true }],
      });
      this.notifyControl(viewer.session);
      await this.#capture(viewer);

      viewer.pollTimer = setInterval(() => void this.#capture(viewer), FRAME_POLL_MS);
      viewer.pollTimer.unref?.();
      viewer.heartbeat = setInterval(() => {
        if (!this.#current(viewer) || (viewer.sentAt !== null && Date.now() - viewer.sentAt > 2 * HEARTBEAT_MS)) {
          this.#close(viewer);
          return;
        }
        this.#sendControl(viewer);
        this.#send(viewer, { type: "heartbeat" });
      }, HEARTBEAT_MS);
      viewer.heartbeat.unref?.();
    } catch (error) {
      clearTimeout(waiting);
      if (options.res.headersSent) {
        this.#send(viewer, {
          type: "error",
          retryable: true,
          message: error instanceof Error ? error.message : "The browser stream could not start.",
        });
        this.#close(viewer);
        return;
      }
      this.#close(viewer, false);
      throw error instanceof BrowserLiveError
        ? error
        : new BrowserLiveError("The browser stream could not start. Reopen the browser panel.", 503);
    }
  }

  #close(viewer: NeoViewer, endResponse = true): void {
    if (viewer.closed) return;
    viewer.closed = true;
    this.#viewers.delete(viewer.id);
    clearInterval(viewer.heartbeat);
    clearInterval(viewer.pollTimer);
    clearTimeout(viewer.drainTimer);
    viewer.pendingFrame = null;
    viewer.sentSeq = null;
    const stillWatchingSamePerson = [...this.#viewers.values()].some(
      (other) => other.session === viewer.session && other.person === viewer.person,
    );
    if (!stillWatchingSamePerson) {
      this.#backend.releaseControl(viewer.session, viewer.person, viewer.id);
    } else if (this.#backend.controllingViewer(viewer.session) === viewer.id) {
      const next = [...this.#viewers.values()].find(
        (other) => other.session === viewer.session && other.person === viewer.person,
      );
      if (next) this.#backend.takeControl(viewer.session, viewer.person, next.id);
    }
    this.notifyControl(viewer.session);
    if (endResponse && !viewer.res.writableEnded && !viewer.res.destroyed) {
      if (viewer.blocked || viewer.res.writableLength > MAX_BUFFER) viewer.res.destroy();
      else viewer.res.end();
    }
  }

  async action({ viewerId, botId, owner, body }: { viewerId: string; botId: string; owner: string; body: unknown }): Promise<unknown> {
    const viewer = this.#viewers.get(viewerId);
    if (!viewer || viewer.botId !== botId || viewer.owner !== owner || !this.#current(viewer)) {
      if (viewer && viewer.botId === botId && viewer.owner === owner) this.#close(viewer);
      throw new BrowserLiveError("This browser view is no longer available. Reopen the browser panel.", 404);
    }
    const action = parseBrowserLiveAction(body);
    if (action.type === "ack") {
      if (viewer.sentSeq === action.seq) {
        viewer.sentSeq = null;
        viewer.sentAt = null;
        this.#flushFrame(viewer);
      }
      return { ok: true };
    }
    if (action.type === "resize") {
      if (action.size) {
        viewer.width = Math.round(action.size.width);
        viewer.height = Math.round(action.size.height);
      }
      return { ok: true };
    }
    if (action.type === "restart") {
      if (viewer.restarting) throw new BrowserLiveError("The browser is already restarting.", 409);
      viewer.restarting = true;
      try {
        await this.#backend.command(viewer.session, { command: "close" }, AbortSignal.timeout(10_000));
        this.closeForSession(viewer.session);
        return { ok: true };
      } finally {
        viewer.restarting = false;
      }
    }
    if (action.type === "release") {
      this.#backend.releaseControl(viewer.session, viewer.person, viewer.id);
      this.notifyControl(viewer.session);
      return { ok: true };
    }
    if (action.type === "take") {
      const holder = this.#backend.heldBy(viewer.session);
      if (holder !== null && holder !== viewer.person) {
        throw new BrowserLiveError(BROWSER_HELD_ELSEWHERE, 409);
      }
      const busy = this.#backend.working(viewer.session);
      if (!this.#backend.takeControl(viewer.session, viewer.person, viewer.id)) {
        throw new BrowserLiveError("Another browser view or bot action is using this browser. Try again shortly.", 409);
      }
      this.notifyControl(viewer.session);
      return { ok: true, waited: busy };
    }
    if (!this.#controlState(viewer).controlling) {
      const holder = this.#backend.heldBy(viewer.session);
      throw new BrowserLiveError(holder && holder !== viewer.person ? BROWSER_HELD_ELSEWHERE : "Browser control changed. Try again.", 409);
    }
    if (viewer.pendingActions >= 32) {
      throw new BrowserLiveError("Too many browser actions are pending. Try again shortly.", 429);
    }
    viewer.pendingActions += 1;
    try {
      const dispatchInput = async (msg: Record<string, unknown>): Promise<void> => {
        if (msg.type === "input_mouse") {
          if (msg.eventType === "mouseWheel") {
            const dy = Number(msg.deltaY ?? 0);
            const dx = Number(msg.deltaX ?? 0);
            const direction = Math.abs(dy) >= Math.abs(dx) ? (dy >= 0 ? "down" : "up") : dx >= 0 ? "right" : "left";
            await this.#backend.command(viewer.session, {
              command: "act",
              skipSnapshot: true,
              actions: [{ kind: "scroll", direction, amount: 3 }],
            });
          } else if (msg.eventType === "mouseReleased") {
            const button = msg.button === "right" || msg.button === "middle" ? msg.button : "left";
            await this.#backend.command(viewer.session, {
              command: "act",
              skipSnapshot: true,
              actions: [{ kind: "click_at", x: Number(msg.x ?? 0), y: Number(msg.y ?? 0), button }],
            });
          }
        } else if (msg.eventType === "char" && typeof msg.text === "string" && msg.text.length > 0) {
          await this.#backend.command(viewer.session, {
            command: "act",
            skipSnapshot: true,
            actions: [{ kind: "type", text: msg.text }],
          });
        } else if (msg.eventType === "keyDown" && typeof msg.key === "string" && msg.key.length > 0 && msg.key.length <= 64) {
          await this.#backend.command(viewer.session, {
            command: "act",
            skipSnapshot: true,
            actions: [{ kind: "press", key: msg.key }],
          });
        }
      };

      if (action.type === "command") {
        const [verb, sub] = action.args;
        if (verb === "back" || verb === "forward" || verb === "reload") {
          await this.#backend.command(viewer.session, { command: "navigate", action: verb });
        } else if (verb === "open" && sub) {
          await this.#backend.command(viewer.session, { command: "navigate", action: "url", url: sub });
        }
      } else if (action.type === "dialog") {
        const dialogStep = action.accept
          ? { kind: "dialog_accept", ...(action.promptText !== undefined ? { text: action.promptText } : {}) }
          : { kind: "dialog_dismiss" };
        await this.#backend.command(viewer.session, { command: "act", skipSnapshot: true, actions: [dialogStep] });
      } else if (action.type === "input") {
        await dispatchInput(action.message as unknown as Record<string, unknown>);
      } else if (action.type === "inputs") {
        for (const msg of action.messages) {
          await dispatchInput(msg as unknown as Record<string, unknown>);
        }
      }
      void this.#capture(viewer);
      return { ok: true };
    } finally {
      viewer.pendingActions -= 1;
      this.notifyControl(viewer.session);
    }
  }

  handBack(session: string): void {
    this.#backend.handBack(session);
    this.notifyControl(session);
  }

  closeForSession(session: string): void {
    for (const viewer of this.#viewers.values()) if (viewer.session === session) this.#close(viewer);
  }

  closeForOwner(owner: string): void {
    for (const viewer of this.#viewers.values()) if (viewer.owner === owner) this.#close(viewer);
  }

  closeForBot(botId: string): void {
    for (const viewer of this.#viewers.values()) if (viewer.botId === botId) this.#close(viewer);
  }

  closeAll(): void {
    for (const viewer of this.#viewers.values()) this.#close(viewer);
  }
}
