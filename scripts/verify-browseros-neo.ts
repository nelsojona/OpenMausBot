// Isolated end-to-end verification for BrowserOS neo proxy routing, RFB VM screen,
// NeoLive stream, and the /browseros-neo slash skill. Never touches live user data.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { WebSocket } from "ws";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "./control-omb.ts";
import { fixtureApi, parkUntilSignal } from "./testing/preview-fixture.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

function createTestPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    const header = y < 44;
    const r = header ? 16 : 30;
    const g = header ? 185 : 48;
    const b = header ? 129 : 74;
    for (let x = 0; x < width; x++) {
      const px = row + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

interface MockMcpState {
  server: HttpServer;
  port: number;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function startMockNeoMcp(): Promise<MockMcpState> {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let currentUrl = "about:blank";
  let currentTitle = "Blank";
  const screenshotBase64 = createTestPng(640, 400).toString("base64");

  const server = createHttpServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: number | string;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    res.setHeader("mcp-session-id", "neo-verify-mcp-session");
    if (rpc.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "browserclaw", version: "0.52.0" },
          },
        }),
      );
      return;
    }
    if (rpc.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name ?? "";
      const args = rpc.params?.arguments ?? {};
      calls.push({ name, arguments: args });
      const nonce = randomBytes(8).toString("hex");
      let content: Array<Record<string, unknown>>;
      if (name === "tabs") {
        const action = args.action;
        if (action === "active") {
          content = [{ type: "text", text: `Active page: [1] ${currentUrl} (${currentTitle})` }];
        } else if (action === "list") {
          content = [{ type: "text", text: `[1] ${currentUrl} (${currentTitle})` }];
        } else if (action === "new") {
          content = [{ type: "text", text: "Opened [1] about:blank ()" }];
        } else {
          content = [{ type: "text", text: "Closed page 1" }];
        }
      } else if (name === "navigate") {
        currentUrl = String(args.url ?? "about:blank");
        currentTitle = "BrowserOS neo Verified Surface";
        content = [{ type: "text", text: `Navigated [1] to ${currentUrl} (${currentTitle})` }];
      } else if (name === "snapshot") {
        const tree = [
          `- heading "${currentTitle}"`,
          `- button "Verify Neo" [ref=e1]`,
          `- textbox "Search query" [ref=e2]`,
        ].join("\n");
        content = [
          {
            type: "text",
            text: `[UNTRUSTED_PAGE_CONTENT nonce=${nonce} origin="${currentUrl}"]\n${tree}\n[END_UNTRUSTED_PAGE_CONTENT nonce=${nonce}]\nSnapshot captured.`,
          },
        ];
      } else if (name === "act") {
        content = [{ type: "text", text: "Completed actions on page 1." }];
      } else if (name === "read") {
        content = [
          {
            type: "text",
            text: `[UNTRUSTED_PAGE_CONTENT nonce=${nonce} origin="${currentUrl}"]\n# BrowserOS neo Verified Surface\nVerified autonomous read through the narrowed proxy.\n[END_UNTRUSTED_PAGE_CONTENT nonce=${nonce}]\nRead complete.`,
          },
        ];
      } else if (name === "screenshot") {
        content = [{ type: "image", mimeType: "image/png", data: screenshotBase64 }];
      } else {
        content = [{ type: "text", text: `Unsupported tool ${name}` }];
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? 1, result: { content } }));
      return;
    }
    res.writeHead(400).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface RawRfbServer {
  port: number;
  keys: number[];
  connections(): number;
  close(): Promise<void>;
}

async function startRawRfbServer(): Promise<RawRfbServer> {
  const keys: number[] = [];
  let connections = 0;
  const sockets = new Set<import("node:net").Socket>();

  const server = createNetServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let pending: Buffer = Buffer.alloc(0);
    let phase = 0;
    let sentFrame = false;
    socket.write(Buffer.from("RFB 003.008\n", "ascii"));

    const width = 320;
    const height = 200;
    const sendFrame = () => {
      const frame = Buffer.alloc(4 + 12 + width * height * 4);
      frame[0] = 0;
      frame.writeUInt16BE(1, 2);
      frame.writeUInt16BE(0, 4);
      frame.writeUInt16BE(0, 6);
      frame.writeUInt16BE(width, 8);
      frame.writeUInt16BE(height, 10);
      frame.writeInt32BE(0, 12);
      for (let y = 0; y < height; y++) {
        const header = y < 48;
        for (let x = 0; x < width; x++) {
          const offset = 16 + (y * width + x) * 4;
          frame[offset] = header ? 129 : 74;
          frame[offset + 1] = header ? 185 : 58;
          frame[offset + 2] = header ? 40 : 38;
          frame[offset + 3] = 255;
        }
      }
      socket.write(frame);
    };

    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        let length: number;
        if (phase === 0) length = 12;
        else if (phase <= 2) length = 1;
        else {
          if (!pending.length) return;
          switch (pending[0]) {
            case 0:
              length = 20;
              break;
            case 2:
              if (pending.length < 4) return;
              length = 4 + pending.readUInt16BE(2) * 4;
              break;
            case 3:
              length = 10;
              break;
            case 4:
              length = 8;
              break;
            case 5:
              length = 6;
              break;
            case 6:
              if (pending.length < 8) return;
              length = 8 + pending.readUInt32BE(4);
              break;
            default:
              socket.destroy();
              return;
          }
        }
        if (pending.length < length) return;
        const message = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (phase === 0) {
          phase++;
          socket.write(Buffer.from([1, 1]));
        } else if (phase === 1) {
          phase++;
          socket.write(Buffer.alloc(4));
        } else if (phase === 2) {
          phase++;
          const name = Buffer.from("Omarchy BrowserOS neo VM", "utf8");
          const init = Buffer.alloc(24 + name.length);
          init.writeUInt16BE(width, 0);
          init.writeUInt16BE(height, 2);
          init[4] = 32;
          init[5] = 24;
          init[6] = 0;
          init[7] = 1;
          init.writeUInt16BE(255, 8);
          init.writeUInt16BE(255, 10);
          init.writeUInt16BE(255, 12);
          init[14] = 16;
          init[15] = 8;
          init[16] = 0;
          init.writeUInt32BE(name.length, 20);
          name.copy(init, 24);
          socket.write(init);
        } else if (message[0] === 3 && (!sentFrame || message[1] === 0)) {
          sentFrame = true;
          sendFrame();
        } else if (message[0] === 4 && message[1] === 1) {
          keys.push(message.readUInt32BE(4));
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    keys,
    connections: () => connections,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpToolResult {
  isError?: boolean;
  tools?: Array<{ name: string }>;
  content?: Array<{ type: string; text?: string }>;
}

async function openStdioMcp(spec: McpServerSpec, homeDir: string) {
  const child = spawn(spec.command, spec.args, {
    env: { PATH: process.env.PATH ?? "", HOME: homeDir, ...spec.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, (msg: { result?: McpToolResult; error?: { message?: string } }) => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const parsed = JSON.parse(line) as { id?: number; result?: McpToolResult; error?: { message?: string } };
    if (parsed.id !== undefined) {
      pending.get(parsed.id)?.(parsed);
      pending.delete(parsed.id);
    }
  });
  let seq = 0;
  const rpc = (method: string, params: unknown = {}): Promise<McpToolResult> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 20_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg.result ?? { isError: true, content: [{ type: "text", text: msg.error?.message ?? "rpc error" }] });
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await rpc("initialize", { protocolVersion: "2024-11-05" });
  return {
    rpc,
    callTool: (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args }),
    close: () => {
      child.kill("SIGTERM");
    },
  };
}

async function waitForTurnDump(dumpPath: string, botId: string): Promise<{ prompt: unknown; mcpServers: Record<string, McpServerSpec> }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(dumpPath)) {
      try {
        const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as {
          prompt?: unknown;
          mcpConfig?: { mcpServers?: Record<string, McpServerSpec> };
        };
        const servers = dump.mcpConfig?.mcpServers ?? {};
        if (servers.agents?.env?.OMB_BOT_ID === botId) {
          return { prompt: dump.prompt, mcpServers: servers };
        }
      } catch {
        // file mid-write
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for turn dump of bot ${botId}`);
}

const scratch = mkdtempSync(join(tmpdir(), "omb-neo-verify-"));
const mcp = await startMockNeoMcp();
const rfb = await startRawRfbServer();
let proxyChild: ChildProcess | undefined;
let fixture: VerificationServer | undefined;

try {
  const proxyPort = await freePort();
  const proxyToken = randomBytes(32).toString("hex");
  const tokenFile = join(scratch, "proxy.token");
  const auditFile = join(scratch, "proxy-audit.jsonl");
  const outputRoot = join(scratch, "tool-output");
  const releaseFile = join(scratch, "release-turn");
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(tokenFile, `${proxyToken}\n`, { mode: 0o600 });

  proxyChild = spawn(process.execPath, [join(root, "deploy/computer-vm/guest/omb-browser-proxy.mjs")], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      OMB_BROWSER_PROXY_TOKEN_FILE: tokenFile,
      OMB_BROWSER_PROXY_LISTEN: `127.0.0.1:${proxyPort}`,
      OMB_BROWSER_PROXY_UPSTREAM: `http://127.0.0.1:${mcp.port}/mcp`,
      OMB_BROWSER_PROXY_LOG: auditFile,
      OMB_BROWSER_PROXY_OUTPUT_ROOT: outputRoot,
      OMB_BROWSER_PROXY_FRONT_TAB: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const healthDeadline = Date.now() + 10_000;
  for (;;) {
    if (Date.now() > healthDeadline) throw new Error("omb-browser-proxy did not become healthy in time");
    try {
      const res = await fetch(`${proxyUrl}/healthz`);
      if (res.ok) break;
    } catch {
      // retry while starting
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  fixture = await launchVerificationServer(
    { ...process.env, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: releaseFile, FAKE_CLAUDE_TOOL_CALLS: "[]" },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    join(root, "dist"),
  );

  const url = fixture.info.url;
  const api = fixtureApi(url, { headers: { origin: url } });
  const proxiesPath = join(fixture.info.dataDir, "browser-proxies.json");

  writeFileSync(
    proxiesPath,
    JSON.stringify(
      {
        default: {
          url: proxyUrl,
          tokenFile,
          screen: { vnc: `127.0.0.1:${rfb.port}` },
        },
      },
      null,
      2,
    ),
  );

  await api("PATCH", "/api/config", {
    features: { browser: true, browserOsNeo: true },
    browserEngine: { engine: "browseros-neo" },
  });

  const configStatus = await api("GET", "/api/config");
  assert.equal(configStatus.browserEngine?.engine, "browseros-neo");

  const atlas = (await api("POST", "/api/bots", { name: "Atlas" })).bot as { id: string; threadId: string };
  await api("PATCH", `/api/bots/${atlas.id}`, { approvalMode: "auto" });

  const localControl = (await api("POST", "/api/bots", { name: "LocalControl" })).bot as { id: string; threadId: string };
  await api("PATCH", `/api/bots/${localControl.id}`, { computer: "browser", approvalMode: "auto" });

  writeFileSync(
    proxiesPath,
    JSON.stringify(
      {
        default: {
          url: proxyUrl,
          tokenFile,
          screen: { vnc: `127.0.0.1:${rfb.port}` },
        },
        bots: {
          [localControl.id]: "local",
        },
      },
      null,
      2,
    ),
  );

  rmSync(fixture.fixtureDumpPath, { force: true });
  rmSync(releaseFile, { force: true });
  await runControlOmb([
    "send",
    "--bot",
    atlas.id,
    "--task",
    atlas.threadId,
    "--text",
    "/browseros-neo Verify https://example.com/neo-check",
    "--url",
    url,
  ]);

  const atlasDump = await waitForTurnDump(fixture.fixtureDumpPath, atlas.id);
  const promptText = JSON.stringify(atlasDump.prompt ?? "");
  assert.ok(promptText.includes("skills/browseros-neo/SKILL.md"), "expected /browseros-neo skill expansion in turn prompt");
  assert.ok(atlasDump.mcpServers.browser, "expected browser MCP server mounted on Atlas turn");

  const atlasBrowser = await openStdioMcp(atlasDump.mcpServers.browser!, fixture.info.dataDir);
  try {
    const toolList = await atlasBrowser.rpc("tools/list");
    const toolNames = (toolList.tools ?? []).map((t) => t.name);
    assert.ok(toolNames.includes("agent_browser_status"));
    assert.ok(toolNames.includes("agent_browser_open"));
    assert.ok(!toolNames.includes("agent_browser_eval"), "agent_browser_eval must not be exposed on Neo");
    assert.ok(!toolNames.includes("agent_browser_upload"), "agent_browser_upload must not be exposed on Neo");

    const statusRes = await atlasBrowser.callTool("agent_browser_status");
    assert.ok(statusRes.content?.[0]?.text?.startsWith("Browser: BrowserOS neo (VM proxy)"));

    const ssrfRes = await atlasBrowser.callTool("agent_browser_open", {
      url: "http://169.254.169.254/latest/meta-data",
    });
    assert.equal(ssrfRes.isError, true);
    assert.ok(ssrfRes.content?.[0]?.text?.includes("local or private network addresses"));
    assert.ok(!mcp.calls.some((call) => String(call.arguments.url ?? "").includes("169.254.169.254")));

    const openRes = await atlasBrowser.callTool("agent_browser_open", {
      url: "https://example.com/neo-check",
    });
    assert.ok(!openRes.isError, openRes.content?.[0]?.text);
    assert.ok(openRes.content?.[0]?.text?.includes("https://example.com/neo-check"));

    const snapRes = await atlasBrowser.callTool("agent_browser_snapshot");
    assert.ok(!snapRes.isError, snapRes.content?.[0]?.text);
    assert.ok(snapRes.content?.[0]?.text?.includes("[e1]"), snapRes.content?.[0]?.text);

    const clickRes = await atlasBrowser.callTool("agent_browser_click", { ref: "e1" });
    assert.ok(!clickRes.isError, clickRes.content?.[0]?.text);

    const readRes = await atlasBrowser.callTool("agent_browser_read");
    assert.ok(!readRes.isError, readRes.content?.[0]?.text);
    assert.ok(readRes.content?.[0]?.text?.includes("Verified autonomous read through the narrowed proxy."));
    assert.ok(!readRes.content?.[0]?.text?.includes("UNTRUSTED_PAGE_CONTENT"));
  } finally {
    atlasBrowser.close();
  }

  writeFileSync(releaseFile, "done\n");
  const atlasWait = (await runControlOmb([
    "wait",
    "--bot",
    atlas.id,
    "--task",
    atlas.threadId,
    "--timeout",
    "20",
    "--url",
    url,
  ])) as { status: string };
  assert.equal(atlasWait.status, "settled");

  const readAuditLines = () =>
    existsSync(auditFile)
      ? readFileSync(auditFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
      : [];
  const auditAfterAtlas = readAuditLines();
  assert.ok(auditAfterAtlas.length >= 4, "expected omb-browser-proxy audit log entries");
  assert.ok(!auditAfterAtlas.some((line) => line.includes(proxyToken)), "proxy token must never appear in audit logs");

  rmSync(fixture.fixtureDumpPath, { force: true });
  rmSync(releaseFile, { force: true });
  await runControlOmb([
    "send",
    "--bot",
    localControl.id,
    "--task",
    localControl.threadId,
    "--text",
    "/browseros-neo Check https://example.com/opted-out",
    "--url",
    url,
  ]);
  const localDump = await waitForTurnDump(fixture.fixtureDumpPath, localControl.id);
  if (localDump.mcpServers.browser) {
    const localBrowser = await openStdioMcp(localDump.mcpServers.browser, fixture.info.dataDir);
    try {
      const localStatus = await localBrowser.callTool("agent_browser_status");
      const text = localStatus.content?.[0]?.text ?? "";
      assert.equal(text.startsWith("Browser: BrowserOS neo"), false);
    } finally {
      localBrowser.close();
    }
  }
  writeFileSync(releaseFile, "done\n");
  const localWait = (await runControlOmb([
    "wait",
    "--bot",
    localControl.id,
    "--task",
    localControl.threadId,
    "--timeout",
    "20",
    "--url",
    url,
  ])) as { status: string };
  assert.equal(localWait.status, "settled");
  assert.equal(readAuditLines().length, auditAfterAtlas.length, "opted-out bot must never hit omb-browser-proxy");

  const computerStatus = await api("GET", `/api/bots/${atlas.id}/computer?threadId=${encodeURIComponent(atlas.threadId)}`);
  assert.equal(computerStatus.surface, "vm");
  const localVmStatus = await api("GET", `/api/bots/${atlas.id}/local-computer?threadId=${encodeURIComponent(atlas.threadId)}`);
  assert.equal(localVmStatus.ready, true);
  assert.equal(localVmStatus.target_key, "neo");
  assert.equal(localVmStatus.viewer_url, "/desktop-viewer#target=local%2Fneo");

  const optedOutVmStatus = await api("GET", `/api/bots/${localControl.id}/local-computer?threadId=${encodeURIComponent(localControl.threadId)}`);
  assert.notEqual(optedOutVmStatus.target_key, "neo");

  const leaseId = "neo-verify-lease-0123456789abcdef";
  const taken = await api("POST", `/api/bots/${atlas.id}/computer/control?threadId=${encodeURIComponent(atlas.threadId)}`, {
    action: "take",
    controlLeaseId: leaseId,
    target: "local/neo",
  });
  assert.equal(taken.held, true);
  const joined = await api(
    "POST",
    `/api/bots/${atlas.id}/local-computer/join?threadId=${encodeURIComponent(atlas.threadId)}&controlLeaseId=${encodeURIComponent(leaseId)}`,
    {},
  );
  assert.ok(String(joined.socketPath ?? "").startsWith("api/desktop-viewer/local/neo/websockify?"));

  const viewerCreds = await api("GET", "/api/desktop-viewer/local/neo");
  assert.equal(viewerCreds.password, null);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http:/, "ws:")}/${joined.socketPath}`, {
      headers: { origin: url },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out waiting for RFB greeting over /api/desktop-viewer/local/neo/websockify"));
    }, 8_000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      const greeting = Buffer.from(data as Buffer).toString("ascii");
      try {
        assert.equal(greeting, "RFB 003.008\n");
        ws.close();
        resolve();
      } catch (err) {
        ws.terminate();
        reject(err);
      }
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const released = await api("POST", `/api/bots/${atlas.id}/computer/control?threadId=${encodeURIComponent(atlas.threadId)}`, {
    action: "release",
    controlLeaseId: leaseId,
  });
  assert.equal(released.held, false);

  const vmShot = await api("POST", `/api/bots/${atlas.id}/local-computer/screenshot`, {});
  assert.equal(typeof vmShot.image, "string");
  assert.ok(vmShot.image.length > 100);

  const liveStreamController = new AbortController();
  const liveResponse = await fetch(`${url}/api/bots/${atlas.id}/browser/live?threadId=${encodeURIComponent(atlas.threadId)}`, {
    headers: { origin: url },
    signal: liveStreamController.signal,
  });
  assert.equal(liveResponse.status, 200);
  const reader = liveResponse.body!.getReader();
  let sseBuffer = "";
  const sseDeadline = Date.now() + 10_000;
  while (Date.now() < sseDeadline && (!sseBuffer.includes("event: status") || !sseBuffer.includes("event: frame"))) {
    const chunk = await reader.read();
    if (chunk.done) break;
    sseBuffer += Buffer.from(chunk.value).toString("utf8");
  }
  liveStreamController.abort();
  assert.ok(sseBuffer.includes("https://example.com/neo-check"), "expected NeoLive SSE status event with active URL");
  assert.ok(sseBuffer.includes("event: frame"), "expected NeoLive SSE frame");

  const summary = {
    ok: true,
    url,
    dataDir: fixture.info.dataDir,
    logPath: fixture.info.logPath,
    proxyUrl,
    auditEntries: readAuditLines().length,
    rfbPort: rfb.port,
    atlasBotId: atlas.id,
    atlasThreadId: atlas.threadId,
    localControlBotId: localControl.id,
  };
  console.log(JSON.stringify(summary));

  if (process.argv.includes("--park")) {
    await parkUntilSignal();
  }
} finally {
  if (fixture) await fixture.close();
  if (proxyChild && proxyChild.exitCode === null) {
    proxyChild.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      proxyChild!.once("close", () => resolve());
      setTimeout(() => {
        proxyChild?.kill("SIGKILL");
        resolve();
      }, 3_000).unref();
    });
  }
  await rfb.close();
  await mcp.close();
  rmSync(scratch, { recursive: true, force: true });
}
