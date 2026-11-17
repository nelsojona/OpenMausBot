import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProxy } from "../../../deploy/computer-vm/guest/omb-browser-proxy.mjs";
import { BUILT_IN_BROWSER_SYSTEM_PROMPT } from "../../browser-engine.ts";
import { BROWSER_CONTROL_REFUSAL } from "../../browser-runtime.ts";
import type { AppConfig } from "../../config.ts";
import { createBrowserHost } from "../../host/browser.ts";
import { NEO_BROWSER_SYSTEM_PROMPT } from "../prompt.ts";
import { neoFeatureActive, resolveNeoRoute } from "./config.ts";
import { NEO_ENGINE, NEO_TOOL_LIST, NeoBrowserEngine, neoTarget } from "./engine.ts";

const TOKEN = "test-neo-engine-token-0123456789abcdef";
const SAMPLE_JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const SAMPLE_PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

function wrapUntrusted(nonce: string, body: string): string {
  return `[UNTRUSTED_PAGE_CONTENT nonce=${nonce} origin=https://example.com]\n${body}\n[END_UNTRUSTED_PAGE_CONTENT nonce=${nonce}]`;
}

function createFakeNeoMcp(options?: { failActOnRef?: string }) {
  let nextPage = 2;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tabs = new Map<number, { page: number; url: string; title: string; tree: string; text: string }>([
    [
      1,
      {
        page: 1,
        url: "about:blank",
        title: "",
        tree: [
          '- heading "Example Domain" [ref=e1]',
          '- link "Learn more" [ref=e2]',
          '- textbox "Query" [ref=e3]: "hello"',
          '- combobox "Country" [ref=e4]',
          '- checkbox "Agree" [ref=e5]',
          '- button "Submit" [ref=e6]',
        ].join("\n"),
        text: "Example Domain paragraph one. Paragraph two with details for pagination.",
      },
    ],
  ]);

  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }),
        { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "neo-mcp-1" } },
      );
    }
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });

    const name = body.params?.name ?? "";
    const args = body.params?.arguments ?? {};
    calls.push({ name, args });

    const reply = (content: unknown[], isError = false, structuredContent?: Record<string, unknown>) =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content, isError, ...(structuredContent ? { structuredContent } : {}) },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    if (name === "name_session") return reply([{ type: "text", text: "ok" }]);
    if (name === "tabs") {
      if (args.action === "active") {
        const first = tabs.get(1)!;
        return reply([{ type: "text", text: `Active page: [1] ${first.url} (${first.title})` }]);
      }
      if (args.action === "list") {
        const lines = [...tabs.values()].map((t) => `[${t.page}] ${t.url} (${t.title})`).join("\n");
        return reply([{ type: "text", text: lines }]);
      }
      if (args.action === "new") {
        const page = nextPage++;
        const template = tabs.get(1)!;
        tabs.set(page, {
          page,
          url: String(args.url ?? "about:blank"),
          title: "",
          tree: template.tree,
          text: template.text,
        });
        return reply([{ type: "text", text: `Opened new tab: [${page}] ${args.url ?? "about:blank"}` }]);
      }
      if (args.action === "close") {
        tabs.delete(Number(args.page));
        return reply([{ type: "text", text: "closed" }]);
      }
    }

    const tab = tabs.get(Number(args.page));
    if (!tab) return reply([{ type: "text", text: `${name} failed: Unknown page ${args.page}. List pages to see what is open.` }], true);

    if (name === "navigate") {
      if (args.action === "url") {
        tab.url = String(args.url);
        tab.title = tab.url === "about:blank" ? "" : "Example Domain";
      } else {
        tab.title = `After ${String(args.action)}`;
      }
      return reply([{ type: "text", text: `Navigated to ${tab.url}` }]);
    }
    if (name === "snapshot") {
      return reply([{ type: "text", text: wrapUntrusted("deadbeef01", tab.tree) }]);
    }
    if (name === "read") {
      const text = args.selector ? `Section(${String(args.selector)})` : tab.text;
      return reply([{ type: "text", text: wrapUntrusted("deadbeef02", text) }]);
    }
    if (name === "screenshot") {
      const png = args.format === "png";
      return reply([
        {
          type: "image",
          data: png ? SAMPLE_PNG_BASE64 : SAMPLE_JPEG_BASE64,
          mimeType: png ? "image/png" : "image/jpeg",
        },
      ]);
    }
    if (name === "wait") {
      return reply([{ type: "text", text: "matched: true" }], false, { matched: true });
    }
    if (name === "act") {
      if (options?.failActOnRef && args.ref === options.failActOnRef) {
        return reply([{ type: "text", text: "act failed: Element detached during click" }], true);
      }
      return reply([{ type: "text", text: "ok" }]);
    }
    return reply([{ type: "text", text: "unknown tool" }], true);
  };

  return { calls, fetchImpl };
}

class FakeSseResponse extends EventEmitter {
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  statusCode = 200;
  readonly chunks: string[] = [];

  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): this {
    this.writableEnded = true;
    this.emit("close");
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

describe("BrowserOS neo routing and engine", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "omb-neo-engine-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  async function startLoopbackProxy(mcpOptions?: { failActOnRef?: string }) {
    const mcp = createFakeNeoMcp(mcpOptions);
    const proxy = createProxy({
      upstream: "http://127.0.0.1:9010/mcp",
      token: TOKEN,
      fetchImpl: mcp.fetchImpl,
      frontTab: true,
    });
    await new Promise<void>((resolve) => proxy.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => proxy.server.close(() => resolve())));
    const port = (proxy.server.address() as AddressInfo).port;
    return { endpoint: `http://127.0.0.1:${port}/v1/page-browser`, mcp };
  }

  it("routes all bots when enabled while excluding My Chrome, optOutBots, and browser-proxies.json local overrides", () => {
    const dataDir = makeTempDir();
    const env: NodeJS.ProcessEnv = { OMB_VM_ROOT: join(dataDir, "no-vms") };
    const cfg: AppConfig = {
      features: { browser: true, browserOsNeo: true },
      browserProfiles: [{ id: "mine", name: "My Chrome", partitionId: "p-mine", browser: "chrome" }],
      browserEngine: {
        engine: "browseros-neo",
        neo: {
          url: "http://127.0.0.1:7791",
          token: TOKEN,
          optOutBots: ["legacy-bot"],
        },
      },
      box: { token: "boat_live_test_key_123456" },
    };

    expect(resolveNeoRoute({ id: "scout" }, cfg, dataDir, env)).toEqual({
      kind: "proxy",
      endpoint: "http://127.0.0.1:7791/v1/page-browser",
      token: TOKEN,
    });
    expect(resolveNeoRoute({ id: "cloud-bot", computer: "cloud" }, cfg, dataDir, env)).toEqual({
      kind: "boat",
      owner: "cloud-bot",
      ownerName: undefined,
    });
    expect(resolveNeoRoute({ id: "legacy-bot" }, cfg, dataDir, env)).toEqual({ kind: "disabled" });

    writeFileSync(
      join(dataDir, "browser-proxies.json"),
      JSON.stringify({
        bots: {
          "container-bot": "local",
        },
      }),
    );
    expect(resolveNeoRoute({ id: "container-bot" }, cfg, dataDir, env)).toEqual({ kind: "disabled" });

    const bots = [
      { id: "scout", name: "Scout" },
      { id: "legacy-bot", name: "Legacy" },
      { id: "chrome-bot", name: "Personal", browserProfile: "mine" },
    ];
    const host = createBrowserHost({
      cfg,
      dataDir,
      store: () => ({
        bots: bots as never,
        bot: (id: string) => (bots.find((b) => b.id === id) ?? null) as never,
        botByThread: () => null,
      }),
      turnResources: { free: () => true, holder: () => undefined, onClaim: () => () => {} },
      activeInternalGenerationByThread: new Map(),
      mintInternalCapability: () => "cap-token",
      DESKTOP_MANAGED: true,
      CLOUD_HOME: null,
      PORT: 4321,
    });
    cleanups.push(() => host.browserSweep.closeAll());

    expect(host.browserSystemPrompt(undefined, "scout")).toBe(NEO_BROWSER_SYSTEM_PROMPT);
    expect(host.browserSystemPrompt("mine", "chrome-bot")).toBe(BUILT_IN_BROWSER_SYSTEM_PROMPT);
    expect(host.browserSystemPrompt(undefined, "legacy-bot")).toBe(BUILT_IN_BROWSER_SYSTEM_PROMPT);
    expect(host.browserReady(undefined, "scout")).toBe(true);
    expect(host.engineSummary({ kind: "unavailable", reason: "none", myChrome: true })).toMatchObject({
      kind: "engine",
      engine: "browseros-neo",
      myChrome: true,
    });
  });

  it("fails closed with an explicit reason when BrowserOS neo is enabled without a proxy or cloud desktop", async () => {
    const dataDir = makeTempDir();
    const env: NodeJS.ProcessEnv = { OMB_VM_ROOT: join(dataDir, "empty-vms") };
    const cfg: AppConfig = {
      features: { browser: true, browserOsNeo: true },
      browserEngine: { engine: "browseros-neo" },
    };
    const engine = new NeoBrowserEngine({
      cfg,
      dataDir,
      env,
      botOf: (id) => ({ id }),
    });
    const spec = engine.spec("bot-scout", "scout");
    const target = neoTarget("bot-scout", spec)!;
    expect(spec.command).toBe(NEO_ENGINE);
    expect(engine.summary()).toMatchObject({ kind: "unavailable" });

    const out = (await engine.agentRpc(target, "tools/call", {
      name: "agent_browser_status",
      arguments: {},
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain("BrowserOS neo is enabled, but no VM proxy or cloud desktop is configured.");
  });

  it("executes narrowed browser tools end-to-end against omb-browser-proxy and blocks eval, upload, and human-held calls", async () => {
    const dataDir = makeTempDir();
    const { endpoint, mcp } = await startLoopbackProxy({ failActOnRef: "e6" });
    const cfg: AppConfig = {
      features: { browser: true, browserOsNeo: true },
      browserEngine: {
        engine: "browseros-neo",
        neo: { url: endpoint, token: TOKEN },
      },
    };
    const engine = new NeoBrowserEngine({
      cfg,
      dataDir,
      env: { OMB_VM_ROOT: join(dataDir, "no-vms") },
      botOf: (id) => ({ id }),
    });
    cleanups.push(() => engine.closeAll());

    const spec = engine.spec("bot-scout", "scout");
    const target = neoTarget("bot-scout", spec)!;

    const listed = (await engine.agentRpc(target, "tools/list", {})) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((t) => t.name)).toEqual(NEO_TOOL_LIST.map((t) => t.name));
    expect(listed.tools.some((t) => t.name === "agent_browser_eval")).toBe(false);
    expect(listed.tools.some((t) => t.name === "agent_browser_upload")).toBe(false);

    const callTool = async (name: string, args: Record<string, unknown> = {}) =>
      (await engine.agentRpc(target, "tools/call", { name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      };

    const statusBefore = await callTool("agent_browser_status");
    expect(statusBefore.isError).toBeUndefined();
    expect(statusBefore.content[0]?.text?.split("\n")[0]).toBe("Browser: BrowserOS neo (VM proxy)");

    const opened = await callTool("agent_browser_open", { url: "example.com" });
    expect(opened.isError).toBeUndefined();
    expect(opened.content[0]?.text).toContain("Example Domain");
    expect(opened.content[0]?.text).toContain("[e3]");

    expect((await callTool("agent_browser_get_url")).content[0]?.text).toBe("https://example.com/");
    expect((await callTool("agent_browser_get_title")).content[0]?.text).toBe("Example Domain");

    const filled = await callTool("agent_browser_fill", { ref: "e3", text: "browseros neo", submit: true });
    expect(filled.isError).toBeUndefined();
    expect(mcp.calls.filter((c) => c.name === "act").map((c) => c.args)).toEqual([
      { page: 1, kind: "fill", ref: "e3", value: "browseros neo", diff: "none" },
      { page: 1, kind: "press", key: "Enter", diff: "none" },
    ]);

    const typed = await callTool("agent_browser_type", { ref: "e3", text: "query", clear: true });
    expect(typed.isError).toBeUndefined();

    const pressed = await callTool("agent_browser_press", { key: "a", modifiers: ["ControlOrMeta"] });
    expect(pressed.isError).toBeUndefined();
    expect(mcp.calls.filter((c) => c.name === "act").at(-1)?.args).toMatchObject({ kind: "press", key: "Control+a" });

    expect((await callTool("agent_browser_select", { ref: "e4", values: ["US"] })).isError).toBeUndefined();
    expect((await callTool("agent_browser_check", { ref: "e5", checked: true })).isError).toBeUndefined();
    expect((await callTool("agent_browser_hover", { ref: "e2" })).isError).toBeUndefined();
    expect((await callTool("agent_browser_scroll", { dy: 400 })).isError).toBeUndefined();
    expect((await callTool("agent_browser_wait", { text: "Example" })).isError).toBeUndefined();

    const pagedRead = await callTool("agent_browser_read", { offset: 8, maxChars: 14 });
    expect(pagedRead.isError).toBeUndefined();
    expect(pagedRead.content[0]?.text).toContain("Domain paragra");
    expect(pagedRead.content[0]?.text).toContain("pass offset=22 to read on");

    const shot = await callTool("agent_browser_screenshot", {});
    expect(shot.isError).toBeUndefined();
    expect(shot.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: SAMPLE_PNG_BASE64 });

    const uncertainFail = await callTool("agent_browser_click", { ref: "e6" });
    expect(uncertainFail.isError).toBe(true);
    expect(uncertainFail.content[0]?.text).toContain("outcome is uncertain");

    const evalDenied = await callTool("agent_browser_eval", { expression: "document.cookie" });
    expect(evalDenied.isError).toBe(true);
    expect(evalDenied.content[0]?.text).toContain("disables arbitrary page JavaScript");

    const uploadDenied = await callTool("agent_browser_upload", { files: ["/tmp/a.txt"], ref: "e3" });
    expect(uploadDenied.isError).toBe(true);

    expect(engine.takeControl("bot-scout", "local-owner", "viewer-1")).toBe(true);
    const heldRefusal = await callTool("agent_browser_status");
    expect(heldRefusal.isError).toBe(true);
    expect(heldRefusal.content[0]?.text).toBe(BROWSER_CONTROL_REFUSAL);
    engine.handBack("bot-scout");
    expect((await callTool("agent_browser_status")).isError).toBeUndefined();
  });

  it("streams v1 live frames and handles take/input/release actions on NeoLive", async () => {
    const dataDir = makeTempDir();
    const { endpoint, mcp } = await startLoopbackProxy();
    const cfg: AppConfig = {
      features: { browser: true, browserOsNeo: true },
      browserEngine: {
        engine: "browseros-neo",
        neo: { url: endpoint, token: TOKEN },
      },
    };
    const engine = new NeoBrowserEngine({
      cfg,
      dataDir,
      env: { OMB_VM_ROOT: join(dataDir, "no-vms") },
      botOf: (id) => ({ id }),
    });
    cleanups.push(() => engine.closeAll());
    engine.spec("bot-scout", "scout");

    const res = new FakeSseResponse();
    await engine.live.open({
      botId: "scout",
      session: "bot-scout",
      owner: "local-owner",
      person: "local-owner",
      isCurrent: () => true,
      res: res as unknown as ServerResponse,
      size: { width: 1280, height: 800 },
    });

    const joined = res.chunks.join("");
    expect(joined).toContain("event: ready\n");
    expect(joined).toContain("event: status\n");
    expect(joined).toContain("event: frame\n");
    const readyMatch = /event: ready\ndata: (\{[^\n]+\})/.exec(joined);
    const viewerId = (JSON.parse(readyMatch![1]!) as { viewerId: string }).viewerId;

    await engine.live.action({
      viewerId,
      botId: "scout",
      owner: "local-owner",
      body: { viewerId, type: "ack", seq: 1 },
    });
    await engine.live.action({
      viewerId,
      botId: "scout",
      owner: "local-owner",
      body: { viewerId, type: "take" },
    });
    expect(engine.heldBy("bot-scout")).toBe("local-owner");

    await engine.live.action({
      viewerId,
      botId: "scout",
      owner: "local-owner",
      body: { viewerId, type: "input_mouse", eventType: "mouseReleased", x: 120, y: 240, button: "left" },
    });
    expect(mcp.calls.some((c) => c.name === "act" && c.args.kind === "click_at")).toBe(true);

    await engine.live.action({
      viewerId,
      botId: "scout",
      owner: "local-owner",
      body: { viewerId, type: "release" },
    });
    expect(engine.heldBy("bot-scout")).toBeNull();
    res.end();
  });

  it("auto-activates BrowserOS neo from a provisioned local VM without manual feature flags", () => {
    const dataDir = makeTempDir();
    const vmRoot = join(dataDir, "vms");
    const vmDir = join(vmRoot, "omb-computer-1");
    mkdirSync(join(vmDir, "secrets"), { recursive: true });
    writeFileSync(join(vmDir, "provisioned"), "ok\n");
    writeFileSync(join(vmDir, "secrets", "browser-proxy.token"), `${TOKEN}\n`);
    const env: NodeJS.ProcessEnv = { OMB_VM_ROOT: vmRoot, OMB_VM_PROXY_PORT: "17791", OMB_VM_SCREEN_PORT: "15981" };
    const cfg: AppConfig = { features: { browser: true } };

    expect(neoFeatureActive(cfg, dataDir, env)).toBe(true);
    expect(resolveNeoRoute({ id: "scout" }, cfg, dataDir, env)).toEqual({
      kind: "proxy",
      endpoint: "http://127.0.0.1:17791/v1/page-browser",
      token: TOKEN,
      screen: { host: "127.0.0.1", port: 15981 },
    });
    expect(neoFeatureActive({ features: { browser: true, browserOsNeo: false } }, dataDir, env)).toBe(false);
  });
});
