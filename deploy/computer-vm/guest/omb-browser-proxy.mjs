#!/usr/bin/env node
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROXY_VERSION = "0.6.0";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ACTIONS = 24;
const MAX_TEXT_CHARS = 12_000;
const MAX_READ_CHARS = 40_000;
const MAX_ELEMENTS = 120;
// BrowserOS neo 0.52.1.1 cuts its accessibility tree around 15,000 characters without saying so.
const TREE_CUT_CHARS = 15_000;
const SAVED_TEXT_BYTES = 128 * 1024;
const OUTPUT_KEEP_MS = 10 * 60 * 1000;
const SAVED_TEXT_NAME = /^read-[0-9]+-[0-9a-f-]+\.(?:txt|md)$/;
const SAVED_PDF_NAME = /^pdf-[0-9]+-[0-9a-f-]+\.pdf$/;
const OUTPUT_NAME = /^(?:read|snapshot|pdf)-[0-9]+-[0-9a-f-]+\.(?:txt|md|pdf)$/;
const MAX_REPLY_BYTES = 400 * 1024;
const MAX_SCREENSHOT_BASE64 = 12 * 1024 * 1024;
const ELEMENT_REF = /^e\d{1,7}$/;
const ELEMENT_ROLE = /^[A-Za-z][A-Za-z-]{0,39}$/;
const TOGGLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
const STALE_MESSAGE = "Stale element ref. Take a fresh snapshot.";
const NO_REASON = "The browser gave no reason.";
const LOCAL_ADDRESS_MESSAGE =
  "This browser runs on its own machine and does not open local or private network addresses.";
const FILE_MESSAGE =
  "This address is a file, not a page. The browser kept the file on its own machine and no page opened.";
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_SESSIONS = 64;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const CALL_TIMEOUT_MS = 20_000;
const IDLE_HOOK_MS = 90_000;
// BrowserOS neo 0.52.1.1 formats `tabs action=active` as `Active page: [<page>] <url> (<title>)`.
const ACTIVE_PAGE = /^Active page: \[(\d+)\] /;
const REQUEST_DEADLINE_MS = 27_000;
const PROTOCOL_VERSION = "2025-06-18";

/** BrowserOS neo 0.52.1.1 wraps untrusted page text in per-call random hex nonces. */
export function unwrapPageContent(text) {
  const blocks = [];
  const pattern =
    /\[UNTRUSTED_PAGE_CONTENT nonce=([0-9a-f]+)[^\]]*\][^\n]*\n([\s\S]*?)\n?\[END_UNTRUSTED_PAGE_CONTENT nonce=\1\]/g;
  for (const match of text.matchAll(pattern)) blocks.push(match[2]);
  return blocks.join("\n");
}

export function savedTextPath(text) {
  const opening = /^\[UNTRUSTED_PAGE_CONTENT nonce=([0-9a-f]+)/.exec(text);
  if (!opening) return undefined;
  const closing = `[END_UNTRUSTED_PAGE_CONTENT nonce=${opening[1]}]`;
  const end = text.lastIndexOf(closing);
  if (end === -1) return undefined;
  return /Content truncated at \d+ chars\. Full content \(\d+ chars\) saved to: (\S+\.(?:txt|md))/.exec(
    text.slice(end + closing.length),
  )?.[1];
}

export function unwrapSavedText(raw) {
  const opening = /^\[UNTRUSTED_PAGE_CONTENT nonce=([0-9a-f]+)[^\]]*\][^\n]*\n/.exec(raw);
  if (!opening) return raw;
  const body = raw.slice(opening[0].length);
  const end = body.lastIndexOf(`[END_UNTRUSTED_PAGE_CONTENT nonce=${opening[1]}]`);
  return end === -1 ? body : body.slice(0, end).replace(/\n$/, "");
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return trimmed;
}

export function parseSnapshot(tree) {
  const rows = [];
  const uses = new Map();
  for (const line of tree.replace(/\r/g, "").split("\n")) {
    const match = /^\s*- ([^\s"[]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?:: (.*))?$/.exec(
      line,
    );
    if (!match || !ELEMENT_ROLE.test(match[1])) continue;
    const marker = [...(match[3] ?? "").matchAll(/ \[([^\]]*)\]/g)]
      .map((group) => group[1])
      .find((group) => group.startsWith("ref="));
    const ref = marker?.slice("ref=".length);
    if (!ref || !ELEMENT_REF.test(ref)) continue;
    const node = {
      ref,
      role: match[1],
      name: (match[2] ?? "").replace(/\\(["\\])/g, "$1").slice(0, 200),
    };
    if (match[4] !== undefined && match[4] !== "") node.value = unquote(match[4]).slice(0, 2000);
    rows.push(node);
    uses.set(ref, (uses.get(ref) ?? 0) + 1);
  }
  const elements = rows.filter((row) => uses.get(row.ref) === 1);
  return { elements, conflicts: rows.length - elements.length };
}

export function parseElements(tree) {
  return parseSnapshot(tree).elements;
}

export function formatTree(elements) {
  if (elements.length === 0) return "(no interactive elements)";
  return elements
    .map((el) => {
      const value =
        el.value !== undefined && el.value !== "" ? ` value=${JSON.stringify(el.value)}` : "";
      return `- ${el.role} "${el.name}" [${el.ref}]${value}`;
    })
    .join("\n");
}

export function normalizeRef(ref) {
  const cleaned = String(ref ?? "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/^ref=/, "");
  return ELEMENT_REF.test(cleaned) ? cleaned : undefined;
}

export function parseTabLine(listing, page) {
  const prefix = `[${page}] `;
  const lines = listing
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) return undefined;
  const [line] = lines;
  const url = line.slice(prefix.length).split(" ", 1)[0].slice(0, 8192);
  const match =
    /^\[\d+\] \S+(?: \((.*?)\))?(?:, owned by [^[]*?)?(?: \[group [0-9A-Fa-f]+\])?$/.exec(line);
  return { url, title: (match?.[1] ?? "").slice(0, 200) };
}

export function localAddress(hostname) {
  const host = String(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 127 ||
      a === 0 ||
      a === 10 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(host)) {
    return host === "::1" || host === "::" || host.startsWith("::ffff:") || /^f[cde]/.test(host);
  }
  return false;
}

function plainFileNameText(value) {
  let text = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    text += code < 32 || code === 127 || '/\\:*?"<>|'.includes(character) ? " " : character;
  }
  return text;
}

export function pdfFileName(title, url) {
  let stem = plainFileNameText(String(title ?? ""))
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, 80)
    .replace(/^[ .]+|[ .]+$/g, "");
  if (!stem) {
    let host = "page";
    try {
      host = new URL(url).hostname || "page";
    } catch {}
    stem = host;
  }
  return `${stem}.pdf`;
}

function coord(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 16_384) {
    throw new Error("Coordinates must be between 0 and 16384");
  }
  return value;
}

function validRefField(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new Error("Invalid browser action");
  }
  return normalizeRef(value);
}

function validateAction(step) {
  if (!step || typeof step !== "object") throw new Error("Invalid browser action");
  switch (step.kind) {
    case "click": {
      const ref = validRefField(step.ref);
      const button = step.button === undefined ? undefined : String(step.button);
      if (button && !["left", "right", "middle"].includes(button)) throw new Error("Invalid button");
      const clickCount = step.clickCount === undefined ? undefined : Number(step.clickCount);
      if (clickCount !== undefined && (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3)) {
        throw new Error("Invalid clickCount");
      }
      return { kind: "click", ref, ...(button ? { button } : {}), ...(clickCount ? { clickCount } : {}) };
    }
    case "click_at": {
      const x = coord(step.x);
      const y = coord(step.y);
      const button = step.button === undefined ? undefined : String(step.button);
      if (button && !["left", "right", "middle"].includes(button)) throw new Error("Invalid button");
      const clickCount = step.clickCount === undefined ? undefined : Number(step.clickCount);
      if (clickCount !== undefined && (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3)) {
        throw new Error("Invalid clickCount");
      }
      return { kind: "click_at", x, y, ...(button ? { button } : {}), ...(clickCount ? { clickCount } : {}) };
    }
    case "fill": {
      const ref = validRefField(step.ref);
      if (typeof step.text !== "string" || step.text.length > 32_000) throw new Error("Text is required");
      return { kind: "fill", ref, text: step.text };
    }
    case "type": {
      const ref = step.ref === undefined ? undefined : validRefField(step.ref);
      if (typeof step.text !== "string" || step.text.length > 32_000) throw new Error("Text is required");
      return { kind: "type", ...(step.ref !== undefined ? { ref, hasRef: true } : {}), text: step.text };
    }
    case "type_at": {
      const x = coord(step.x);
      const y = coord(step.y);
      if (typeof step.text !== "string" || step.text.length > 32_000) throw new Error("Text is required");
      return { kind: "type_at", x, y, text: step.text, ...(step.clear === true ? { clear: true } : {}) };
    }
    case "press": {
      if (typeof step.key !== "string" || step.key.length < 1 || step.key.length > 64) {
        throw new Error("Invalid key");
      }
      return { kind: "press", key: step.key };
    }
    case "hover":
      return { kind: "hover", ref: validRefField(step.ref) };
    case "hover_at":
      return { kind: "hover_at", x: coord(step.x), y: coord(step.y) };
    case "check":
    case "uncheck":
      return { kind: step.kind, ref: validRefField(step.ref) };
    case "select": {
      const ref = validRefField(step.ref);
      if (typeof step.value !== "string" || step.value.length > 1000) throw new Error("Option value is required");
      return { kind: "select", ref, value: step.value };
    }
    case "scroll": {
      const direction = String(step.direction ?? "down");
      if (!["up", "down", "left", "right"].includes(direction)) throw new Error("Invalid scroll direction");
      const amount = step.amount === undefined ? 3 : Number(step.amount);
      if (!Number.isFinite(amount) || amount < 0.1 || amount > 200) throw new Error("Invalid scroll amount");
      const ref = step.ref === undefined ? undefined : validRefField(step.ref);
      return { kind: "scroll", direction, amount, ...(step.ref !== undefined ? { ref, hasRef: true } : {}) };
    }
    case "drag":
      return { kind: "drag", ref: validRefField(step.ref), targetRef: validRefField(step.targetRef) };
    case "drag_at":
      return {
        kind: "drag_at",
        startX: coord(step.startX),
        startY: coord(step.startY),
        endX: coord(step.endX),
        endY: coord(step.endY),
      };
    case "dialog_accept": {
      const text = step.text === undefined ? undefined : String(step.text);
      if (text !== undefined && text.length > 4000) throw new Error("Dialog text too long");
      return { kind: "dialog_accept", ...(text !== undefined ? { text } : {}) };
    }
    case "dialog_dismiss":
      return { kind: "dialog_dismiss" };
    default:
      throw new Error("Invalid browser action");
  }
}

export function validateCommand(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Expected a JSON object");
  }
  if (body.command === "status" || body.command === "snapshot" || body.command === "pdf" || body.command === "close") {
    return { command: body.command };
  }
  if (body.command === "navigate") {
    const action = body.action === undefined ? "url" : String(body.action);
    if (["back", "forward", "reload"].includes(action)) {
      return { command: "navigate", action };
    }
    if (action !== "url") throw new Error("Invalid navigate action");
    const url = String(body.url ?? "");
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Only HTTP(S) URLs without embedded credentials are supported");
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || url.length > 8192) {
      throw new Error("Only HTTP(S) URLs without embedded credentials are supported");
    }
    return { command: "navigate", action: "url", url };
  }
  if (body.command === "read") {
    const format = body.format === "markdown" ? "markdown" : "text";
    const selector = typeof body.selector === "string" && body.selector.length <= 2048 ? body.selector : undefined;
    const offset = body.offset === undefined ? 0 : Number(body.offset);
    const maxChars = body.maxChars === undefined ? 20_000 : Number(body.maxChars);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10_000_000) throw new Error("Invalid offset");
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_READ_CHARS) throw new Error("Invalid maxChars");
    return { command: "read", format, ...(selector ? { selector } : {}), offset, maxChars };
  }
  if (body.command === "screenshot") {
    const format = body.format === "png" ? "png" : "jpeg";
    const quality = body.quality === undefined ? 75 : Number(body.quality);
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error("Invalid quality");
    const width = body.width === undefined ? undefined : Number(body.width);
    const height = body.height === undefined ? undefined : Number(body.height);
    if (width !== undefined && (!Number.isInteger(width) || width < 1 || width > 4096)) throw new Error("Invalid width");
    if (height !== undefined && (!Number.isInteger(height) || height < 1 || height > 4096)) throw new Error("Invalid height");
    return {
      command: "screenshot",
      format,
      quality,
      fullPage: body.fullPage === true,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    };
  }
  if (body.command === "wait") {
    const kind = String(body.for ?? "time");
    if (!["time", "text", "selector"].includes(kind)) throw new Error("Invalid wait condition");
    const timeout = body.timeout === undefined ? undefined : Math.min(20_000, Math.max(100, Number(body.timeout)));
    if (kind === "time") {
      const ms = body.value === undefined ? 1000 : Number(body.value);
      if (!Number.isFinite(ms) || ms < 0 || ms > 20_000) throw new Error("Invalid wait ms");
      return { command: "wait", for: "time", value: Math.round(ms) };
    }
    if (typeof body.value !== "string" || body.value.length < 1 || body.value.length > 2048) {
      throw new Error("Wait value is required");
    }
    return { command: "wait", for: kind, value: body.value, ...(timeout ? { timeout } : {}) };
  }
  if (body.command === "act") {
    if (!Array.isArray(body.actions) || body.actions.length < 1 || body.actions.length > MAX_ACTIONS) {
      throw new Error(`Expected 1 to ${MAX_ACTIONS} actions`);
    }
    return {
      command: "act",
      actions: body.actions.map(validateAction),
      skipSnapshot: body.skipSnapshot === true,
    };
  }
  // Security invariant: never forward unknown commands or expose BrowserOS neo's credentials/payment_cards/eval tools.
  throw new Error("Unknown command");
}

export class McpClient {
  constructor(upstream, fetchImpl = fetch, callTimeoutMs = CALL_TIMEOUT_MS) {
    this.upstream = upstream;
    this.fetchImpl = fetchImpl;
    this.callTimeoutMs = callTimeoutMs;
    this.sessionId = undefined;
    this.nextId = 1;
  }

  async post(payload, signal) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
      headers["mcp-protocol-version"] = PROTOCOL_VERSION;
    }
    const response = await this.fetchImpl(this.upstream, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.callTimeoutMs)]),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`browser endpoint answered ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (payload.id === undefined) return undefined;
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        let message;
        try {
          message = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (message?.id === payload.id) return message;
      }
      throw new Error("browser endpoint sent no reply");
    }
    return JSON.parse(text);
  }

  async initialize(signal) {
    this.sessionId = undefined;
    const reply = await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "openmausbot", version: PROXY_VERSION },
        },
      },
      signal,
    );
    if (reply?.error) {
      throw new Error(reply.error.message ?? "browser endpoint refused the session");
    }
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
  }

  async callTool(name, args, signal) {
    for (let attempt = 0; ; attempt += 1) {
      if (!this.sessionId) await this.initialize(signal);
      try {
        const reply = await this.post(
          {
            jsonrpc: "2.0",
            id: this.nextId++,
            method: "tools/call",
            params: { name, arguments: args },
          },
          signal,
        );
        if (reply?.error) {
          return { isError: true, text: String(reply.error.message ?? "tool call failed"), content: [] };
        }
        const result = reply?.result ?? {};
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
        return { isError: result.isError === true, text, content, structured: result.structuredContent };
      } catch (error) {
        if (attempt === 0 && (error?.status === 404 || error?.status === 400) && this.sessionId) {
          this.sessionId = undefined;
          continue;
        }
        throw error;
      }
    }
  }
}

function firstLine(text) {
  return (text.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, 500);
}

// BrowserOS neo 0.52.1.1 failure lines for unknown element refs, closed pages and file downloads.
const STALE_REF = /^act failed: Unknown ref (\S+); take a new snapshot\.$/;
const MISSING_PAGE = /^[a-z_]+ failed: Unknown page \d+\. List pages to see what is open\.$/;
const SAVED_AS_FILE = /^\S+ is a file, so the browser downloaded it; the page did not change\.$/;

function messageOf(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500) || NO_REASON;
}

function reasonOf(text) {
  return firstLine(text) || NO_REASON;
}

function fitReply(result, rebuild) {
  while (result.elements.length > 0 && Buffer.byteLength(JSON.stringify(result)) > MAX_REPLY_BYTES) {
    result.elements = result.elements.slice(0, Math.floor(result.elements.length / 2));
    rebuild();
  }
  return result;
}

function stepRefs(step) {
  const refs = [];
  if (step.kind === "click" || step.kind === "fill" || step.kind === "hover" || step.kind === "check" || step.kind === "uncheck" || step.kind === "select") {
    refs.push(step.ref);
  } else if ((step.kind === "type" || step.kind === "scroll") && step.hasRef) {
    refs.push(step.ref);
  } else if (step.kind === "drag") {
    refs.push(step.ref, step.targetRef);
  }
  return refs;
}

function neoActArgs(page, step) {
  switch (step.kind) {
    case "click":
      return { page, kind: "click", ref: step.ref, ...(step.button ? { button: step.button } : {}), ...(step.clickCount ? { clickCount: step.clickCount } : {}), diff: "none" };
    case "click_at":
      return { page, kind: "click_at", x: step.x, y: step.y, ...(step.button ? { button: step.button } : {}), ...(step.clickCount ? { clickCount: step.clickCount } : {}), diff: "none" };
    case "fill":
      return { page, kind: "fill", ref: step.ref, value: step.text, diff: "none" };
    case "type":
      return { page, kind: "type", ...(step.ref ? { ref: step.ref } : {}), text: step.text, diff: "none" };
    case "type_at":
      return { page, kind: "type_at", x: step.x, y: step.y, text: step.text, ...(step.clear ? { clear: true } : {}), diff: "none" };
    case "press":
      return { page, kind: "press", key: step.key, diff: "none" };
    case "hover":
      return { page, kind: "hover", ref: step.ref, diff: "none" };
    case "hover_at":
      return { page, kind: "hover_at", x: step.x, y: step.y, diff: "none" };
    case "check":
    case "uncheck":
      return { page, kind: step.kind, ref: step.ref, diff: "none" };
    case "select":
      return { page, kind: "select", ref: step.ref, value: step.value, diff: "none" };
    case "scroll":
      return { page, kind: "scroll", direction: step.direction, amount: step.amount, ...(step.ref ? { ref: step.ref } : {}), diff: "none" };
    case "drag":
      return { page, kind: "drag", ref: step.ref, targetRef: step.targetRef, diff: "none" };
    case "drag_at":
      return { page, kind: "drag_at", startX: step.startX, startY: step.startY, endX: step.endX, endY: step.endY, diff: "none" };
    case "dialog_accept":
      return { page, kind: "dialog_accept", ...(step.text !== undefined ? { value: step.text } : {}), diff: "none" };
    case "dialog_dismiss":
      return { page, kind: "dialog_dismiss", diff: "none" };
    default:
      throw new Error("Invalid browser action");
  }
}

export class BrowserSession {
  constructor(client, label, front) {
    this.client = client;
    this.label = label;
    this.front = front;
    this.adopted = false;
    this.page = undefined;
    this.refs = undefined;
    this.named = false;
    this.lastUsed = Date.now();
    this.queue = Promise.resolve();
  }

  run(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async name(signal) {
    if (this.named) return;
    this.named = true;
    await this.client
      .callTool("name_session", { name: this.label, category: "other", summary: "OpenMausBot browser session" }, signal)
      .catch(() => undefined);
  }

  async openPage(url, signal) {
    const opened = await this.client.callTool("tabs", { action: "new", url }, signal);
    const page = /^opened page (\d+)$/.exec(firstLine(opened.text))?.[1];
    if (opened.isError || !page) {
      throw new Error(firstLine(opened.text) || "The browser opened no page");
    }
    this.page = Number(page);
    await this.name(signal);
    return opened;
  }

  forgetPage() {
    this.page = undefined;
    this.adopted = false;
    this.front?.release(this);
  }

  async adoptFrontPage(signal) {
    if (!this.front?.take(this)) return false;
    try {
      const active = await this.client.callTool("tabs", { action: "active" }, signal);
      const match = active.isError ? undefined : ACTIVE_PAGE.exec(firstLine(active.text));
      if (match) {
        this.page = Number(match[1]);
        this.adopted = true;
        await this.name(signal);
        return true;
      }
    } catch (error) {
      this.front.release(this);
      throw error;
    }
    this.front.release(this);
    return false;
  }

  async ensurePage(signal) {
    if (this.page === undefined && !(await this.adoptFrontPage(signal))) {
      await this.openPage("about:blank", signal);
    }
    return this.page;
  }

  async info(signal) {
    const listing = await this.client.callTool("tabs", { action: "list" }, signal);
    return parseTabLine(listing.text, this.page) ?? { url: "", title: "" };
  }

  async status(signal) {
    if (this.page === undefined) {
      const listing = await this.client.callTool("tabs", { action: "active" }, signal);
      if (listing.isError) return { ok: false, error: reasonOf(listing.text) };
      return { ok: true, url: "about:blank", title: "", page: null, adopted: false };
    }
    const info = await this.info(signal);
    return { ok: true, url: info.url || "about:blank", title: info.title, page: this.page, adopted: this.adopted };
  }

  async navigate(command, signal) {
    this.refs = new Set();
    let page = await this.ensurePage(signal);
    const args = command.action === "url" ? { page, action: "url", url: command.url } : { page, action: command.action };
    let reply = await this.client.callTool("navigate", args, signal);
    if (reply.isError && MISSING_PAGE.test(firstLine(reply.text))) {
      this.forgetPage();
      page = await this.ensurePage(signal);
      const retryArgs = command.action === "url" ? { page, action: "url", url: command.url } : { page, action: command.action };
      reply = await this.client.callTool("navigate", retryArgs, signal);
    }
    if (reply.isError) return { ok: false, url: command.url ?? "", title: "", error: reasonOf(reply.text) };
    if (SAVED_AS_FILE.test(firstLine(reply.text))) {
      return { ok: false, url: command.url ?? "", title: "", error: FILE_MESSAGE };
    }
    const info = await this.info(signal);
    return { ok: true, url: info.url || command.url || "about:blank", title: info.title };
  }

  async snapshot(signal, files) {
    const page = await this.ensurePage(signal);
    const tree = await this.client.callTool("snapshot", { page, mode: "interactive" }, signal);
    if (tree.isError) {
      const lost = MISSING_PAGE.test(firstLine(tree.text));
      const where = lost
        ? { url: "", title: "" }
        : await this.info(signal).catch(() => ({ url: "", title: "" }));
      if (lost) this.forgetPage();
      this.refs = lost ? undefined : new Set();
      return { ok: false, ...where, error: reasonOf(tree.text) };
    }
    const read = await this.client.callTool("read", { page, format: "text" }, signal);
    const info = await this.info(signal);
    const listed = unwrapPageContent(tree.text);
    const parsed = parseSnapshot(listed);
    let text = read.isError ? "" : unwrapPageContent(read.text);
    let cut = false;
    const saved = read.isError ? undefined : savedTextPath(read.text);
    if (saved) {
      const full = await files?.readText(saved).catch(() => undefined);
      if (full === undefined) cut = true;
      else text = full;
    }
    cut ||= text.length > MAX_TEXT_CHARS;
    const result = {
      ok: true,
      url: info.url,
      title: info.title,
      tree: "",
      elements: parsed.elements.slice(0, MAX_ELEMENTS),
      truncated: false,
    };
    const rebuild = () => {
      const partial =
        parsed.elements.length > result.elements.length || listed.length >= TREE_CUT_CHARS;
      result.truncated = partial || cut;
      const lines = [text.slice(0, MAX_TEXT_CHARS)];
      if (cut) lines.push("[The page text continues beyond this point.]");
      lines.push(formatTree(result.elements));
      if (partial) {
        result.notice = `Only the first ${result.elements.length} interactive elements are listed.`;
        lines.push(`(${result.notice})`);
      }
      if (parsed.conflicts > 0) {
        lines.push(`(${parsed.conflicts} rows were left out because the page listed one ref twice.)`);
      }
      if (result.elements.some((element) => TOGGLE_ROLES.has(element.role))) {
        lines.push("(This browser does not report whether a box or option is ticked.)");
      }
      result.tree = lines.join("\n");
    };
    rebuild();
    fitReply(result, rebuild);
    this.refs = new Set(result.elements.map((element) => element.ref));
    return result;
  }

  async read(command, signal, files) {
    const page = await this.ensurePage(signal);
    const read = await this.client.callTool(
      "read",
      { page, format: command.format, ...(command.selector ? { selector: command.selector } : {}) },
      signal,
    );
    const info = await this.info(signal).catch(() => ({ url: "", title: "" }));
    if (read.isError) return { ok: false, ...info, error: reasonOf(read.text) };
    let text = unwrapPageContent(read.text);
    let fileMissing = false;
    const saved = savedTextPath(read.text);
    if (saved) {
      const full = await files?.readText(saved).catch(() => undefined);
      if (full === undefined) fileMissing = true;
      else text = full;
    }
    const totalChars = text.length;
    const slice = text.slice(command.offset, command.offset + command.maxChars);
    const truncated = fileMissing || command.offset + command.maxChars < totalChars;
    return { ok: true, ...info, text: slice, totalChars, truncated };
  }

  async screenshot(command, signal) {
    const page = await this.ensurePage(signal);
    const size = command.width || command.height
      ? { ...(command.width ? { width: command.width } : {}), ...(command.height ? { height: command.height } : {}) }
      : undefined;
    const reply = await this.client.callTool(
      "screenshot",
      {
        page,
        format: command.format,
        ...(command.format === "jpeg" ? { quality: command.quality } : {}),
        scale: "css",
        ...(command.fullPage ? { fullPage: true } : {}),
        ...(size ? { size } : {}),
      },
      signal,
    );
    const info = await this.info(signal).catch(() => ({ url: "", title: "" }));
    if (reply.isError) return { ok: false, ...info, error: reasonOf(reply.text) };
    const image = reply.content.find(
      (part) =>
        part?.type === "image" &&
        typeof part.data === "string" &&
        part.data.length > 0 &&
        part.data.length <= MAX_SCREENSHOT_BASE64 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(part.data),
    );
    if (!image) return { ok: false, ...info, error: "The browser returned no screenshot." };
    const mimeType = image.mimeType === "image/png" ? "image/png" : "image/jpeg";
    return {
      ok: true,
      ...info,
      data: image.data,
      mimeType,
      format: mimeType === "image/png" ? "png" : "jpeg",
    };
  }

  async wait(command, signal) {
    const page = await this.ensurePage(signal);
    const reply = await this.client.callTool(
      "wait",
      {
        page,
        for: command.for,
        value: command.value,
        ...(command.timeout ? { timeout: command.timeout } : {}),
      },
      signal,
    );
    const info = await this.info(signal).catch(() => ({ url: "", title: "" }));
    if (reply.isError) return { ok: false, ...info, error: reasonOf(reply.text) };
    const matched = reply.structured?.matched !== false && !/\bmatched:\s*false\b|timed out/i.test(reply.text);
    return { ok: true, ...info, matched };
  }

  async act(actions, skipSnapshot, signal, files) {
    for (const step of actions) {
      for (const ref of stepRefs(step)) {
        if (!ref || (this.refs && !this.refs.has(ref))) {
          return { ok: false, completed: 0, uncertain: false, error: STALE_MESSAGE };
        }
      }
    }
    const page = await this.ensurePage(signal);
    let completed = 0;
    for (const step of actions) {
      const args = neoActArgs(page, step);
      let reply;
      try {
        reply = await this.client.callTool("act", args, signal);
      } catch (error) {
        this.refs = new Set();
        return { ok: false, completed, uncertain: true, error: messageOf(error) };
      }
      if (reply.isError) {
        this.refs = new Set();
        const line = firstLine(reply.text);
        const staleRef = STALE_REF.exec(line)?.[1];
        const stale = Boolean(staleRef && stepRefs(step).includes(staleRef));
        return {
          ok: false,
          completed,
          uncertain: !stale,
          error: stale ? STALE_MESSAGE : line || NO_REASON,
        };
      }
      completed += 1;
    }
    if (skipSnapshot) {
      this.refs = new Set();
      const info = await this.info(signal).catch(() => ({ url: "", title: "" }));
      return { ok: true, ...info, completed };
    }
    let snapshot;
    try {
      snapshot = await this.snapshot(signal, files);
    } catch (error) {
      this.refs = new Set();
      return { ok: false, completed, uncertain: false, error: messageOf(error) };
    }
    if (snapshot.ok !== true) return { ...snapshot, ok: false, completed, uncertain: false };
    return { ...snapshot, completed };
  }

  async pdf(signal, files) {
    const page = await this.ensurePage(signal);
    const info = await this.info(signal);
    const saved = await this.client.callTool("pdf", { page, printBackground: true }, signal);
    const match = /Saved page \d+ as PDF \((\d+) bytes\) to: (\S.*)$/m.exec(saved.text);
    if (saved.isError || !match) {
      return {
        ok: false,
        url: info.url,
        title: info.title,
        error: firstLine(saved.text) || "No PDF was produced.",
      };
    }
    let data;
    try {
      data = await files.readPdf(match[2].trim());
    } catch (error) {
      return { ok: false, url: info.url, title: info.title, error: messageOf(error) };
    }
    if (data.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return { ok: false, url: info.url, title: info.title, error: "The browser returned no PDF" };
    }
    return {
      ok: true,
      url: info.url,
      title: info.title,
      fileName: pdfFileName(info.title, info.url),
      bytes: data.byteLength,
      data: data.toString("base64"),
    };
  }

  async close(signal) {
    if (this.page === undefined) return;
    const page = this.page;
    const adopted = this.adopted;
    this.page = undefined;
    this.adopted = false;
    try {
      await this.client.callTool(
        adopted ? "navigate" : "tabs",
        adopted ? { page, action: "url", url: "about:blank" } : { action: "close", page },
        signal,
      );
    } catch {
    } finally {
      this.front?.release(this);
    }
  }
}

function tokenMatches(header, token) {
  const supplied = Buffer.from(/^bearer /i.test(header ?? "") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createProxy({
  upstream,
  token,
  audit = async () => {},
  fetchImpl = fetch,
  outputRoot,
  callTimeoutMs = CALL_TIMEOUT_MS,
  deadlineMs = REQUEST_DEADLINE_MS,
  maxSessions = MAX_SESSIONS,
  maxPdfBytes = MAX_PDF_BYTES,
  now = () => Date.now(),
  frontTab = false,
  onActive,
  onIdle,
  idleMs = IDLE_HOOK_MS,
}) {
  if (!token || token.length < 24) throw new Error("A token of at least 24 characters is required");
  let frontHolder;
  const front = frontTab
    ? {
        take(session) {
          if (frontHolder && frontHolder !== session) return false;
          frontHolder = session;
          return true;
        },
        release(session) {
          if (frontHolder === session) frontHolder = undefined;
        },
      }
    : undefined;
  const sessions = new Map();
  let active = false;
  let idleTimer;

  function wake() {
    clearTimeout(idleTimer);
    if (active) return;
    active = true;
    try {
      onActive?.();
    } catch {}
  }

  function rest() {
    clearTimeout(idleTimer);
    if (!active) return;
    idleTimer = setTimeout(() => {
      active = false;
      try {
        onIdle?.();
      } catch {}
    }, idleMs);
    idleTimer.unref();
  }

  function outputFile(file, name) {
    const resolved = path.resolve(file);
    if (
      !outputRoot ||
      path.dirname(resolved) !== path.resolve(outputRoot) ||
      !name.test(path.basename(resolved))
    ) {
      throw new Error("The file was saved outside the browser's output folder");
    }
    return resolved;
  }

  const files = {
    async readPdf(file) {
      const resolved = outputFile(file, SAVED_PDF_NAME);
      const info = await stat(resolved);
      const data = info.size > maxPdfBytes ? undefined : await readFile(resolved);
      await unlink(resolved).catch(() => undefined);
      if (!data) throw new Error("The PDF is larger than 25 MB");
      return data;
    },
    async readText(file) {
      const resolved = outputFile(file, SAVED_TEXT_NAME);
      const handle = await open(resolved, "r");
      try {
        const buffer = Buffer.alloc(SAVED_TEXT_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, SAVED_TEXT_BYTES, 0);
        return unwrapSavedText(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await handle.close();
        await unlink(resolved).catch(() => undefined);
      }
    },
  };

  function sessionFor(key) {
    let session = sessions.get(key);
    if (!session) {
      if (sessions.size >= maxSessions) {
        const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        sessions.delete(oldest[0]);
        void oldest[1].close(AbortSignal.timeout(5000));
      }
      session = new BrowserSession(
        new McpClient(upstream, fetchImpl, callTimeoutMs),
        `openmausbot ${key.slice(0, 24)}`,
        front,
      );
      sessions.set(key, session);
    }
    session.lastUsed = now();
    return session;
  }

  async function sweepOutput() {
    if (!outputRoot) return;
    const root = path.resolve(outputRoot);
    for (const name of await readdir(root).catch(() => [])) {
      if (!OUTPUT_NAME.test(name)) continue;
      const file = path.join(root, name);
      const info = await stat(file).catch(() => undefined);
      if (info?.isFile() && now() - info.mtimeMs > OUTPUT_KEEP_MS) {
        await unlink(file).catch(() => undefined);
      }
    }
  }

  async function sweep() {
    for (const [key, session] of sessions) {
      if (now() - session.lastUsed < SESSION_IDLE_MS) continue;
      sessions.delete(key);
      await session.close(AbortSignal.timeout(5000));
    }
    await sweepOutput();
  }

  async function handle(command, key) {
    if (command.command === "close") {
      const ending = sessions.get(key);
      if (ending) {
        sessions.delete(key);
        await ending.run(() => ending.close(AbortSignal.timeout(5000)));
      }
      return { ok: true };
    }
    if (command.command === "navigate" && command.action === "url" && localAddress(new URL(command.url).hostname)) {
      return { ok: false, url: command.url, title: "", error: LOCAL_ADDRESS_MESSAGE };
    }
    const session = sessionFor(key);
    const signal = AbortSignal.timeout(deadlineMs);
    return session.run(async () => {
      try {
        if (command.command === "status") return await session.status(signal);
        if (command.command === "navigate") return await session.navigate(command, signal);
        if (command.command === "snapshot") return await session.snapshot(signal, files);
        if (command.command === "read") return await session.read(command, signal, files);
        if (command.command === "screenshot") return await session.screenshot(command, signal);
        if (command.command === "wait") return await session.wait(command, signal);
        if (command.command === "act") return await session.act(command.actions, command.skipSnapshot, signal, files);
        return await session.pdf(signal, files);
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        return {
          ok: false,
          ...(command.command === "act" ? { completed: 0, uncertain: true } : {}),
          error: timedOut
            ? "The browser did not answer in time."
            : `The browser is unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
        };
      }
    });
  }

  const server = http.createServer(async (request, response) => {
    const started = now();
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
      });
      response.end(payload);
    };
    try {
      const url = new URL(request.url ?? "/", "http://proxy");
      if (request.method === "GET" && url.pathname === "/healthz") {
        return send(200, { ok: true, browser: "browseros-neo", version: PROXY_VERSION });
      }
      if (!tokenMatches(request.headers.authorization, token)) {
        return send(401, { ok: false, error: "unauthorized" });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/page-browser") {
        return send(404, { ok: false, error: "not found" });
      }
      const key = String(
        request.headers["x-omb-browser-session"] ?? request.headers["x-atlas-browser-session"] ?? "default",
      );
      if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(key)) {
        return send(400, { ok: false, error: "invalid session" });
      }
      let command;
      try {
        command = validateCommand(JSON.parse(await readBody(request)));
      } catch (error) {
        return send(error?.status ?? 400, {
          ok: false,
          error: error instanceof Error ? error.message : "bad request",
        });
      }
      if (command.command !== "close") wake();
      let result;
      try {
        result = await handle(command, key);
      } finally {
        rest();
      }
      let host;
      if (command.command === "navigate" && command.url) {
        try {
          host = new URL(command.url).host;
        } catch {}
      }
      await audit({
        ts: new Date(now()).toISOString(),
        session: key,
        command: command.command,
        ...(host ? { host } : {}),
        ...(command.command === "act" ? { actions: command.actions.map((step) => step.kind) } : {}),
        ok: result.ok === true,
        ms: now() - started,
      }).catch(() => undefined);
      return send(200, result);
    } catch {
      return send(500, { ok: false, error: "proxy error" });
    }
  });
  const timer = setInterval(() => void sweep(), 60_000);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    clearTimeout(idleTimer);
  });
  return { server, sessions, sweep };
}

function hookRunner(command) {
  if (!command) return undefined;
  return () => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  };
}

async function main() {
  const env = process.env;
  const tokenFile = env.OMB_BROWSER_PROXY_TOKEN_FILE;
  if (!tokenFile) throw new Error("OMB_BROWSER_PROXY_TOKEN_FILE is required");
  const token = (await readFile(tokenFile, "utf8")).trim();
  const [host, port] = (env.OMB_BROWSER_PROXY_LISTEN ?? "0.0.0.0:7791").split(":");
  const upstream = env.OMB_BROWSER_PROXY_UPSTREAM ?? "http://127.0.0.1:9010/mcp";
  const logFile =
    env.OMB_BROWSER_PROXY_LOG ??
    path.join(
      env.XDG_STATE_HOME ?? path.join(env.HOME ?? ".", ".local/state"),
      "omb-browser-proxy/audit.jsonl",
    );
  await mkdir(path.dirname(logFile), { recursive: true });
  const idleSeconds = Number(env.OMB_BROWSER_PROXY_IDLE_SECONDS ?? "");
  const { server } = createProxy({
    upstream,
    token,
    outputRoot:
      env.OMB_BROWSER_PROXY_OUTPUT_ROOT ?? path.join(env.HOME ?? ".", ".browseros/tool-output"),
    audit: (entry) => appendFile(logFile, `${JSON.stringify(entry)}\n`),
    frontTab: env.OMB_BROWSER_PROXY_FRONT_TAB === "1",
    onActive: hookRunner(env.OMB_BROWSER_PROXY_ACTIVE_HOOK),
    onIdle: hookRunner(env.OMB_BROWSER_PROXY_IDLE_HOOK),
    ...(Number.isFinite(idleSeconds) && idleSeconds >= 1 ? { idleMs: idleSeconds * 1000 } : {}),
  });
  server.listen(Number(port), host, () => {
    process.stdout.write(
      `omb-browser-proxy ${PROXY_VERSION} listening on ${host}:${port}, upstream ${upstream}\n`,
    );
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
