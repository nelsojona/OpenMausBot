import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { CONFIG_BACKUP_PREFIX } from "./config-backup.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";
import { startFakeOAuth, type FakeOAuth } from "./testing/fake-oauth-server.ts";

type Dump = {
  prompt?: string;
  systemPrompt: string | null;
  mcpConfig: { mcpServers: Record<string, { url?: string; headers?: Record<string, string> }> };
};

let oauth: FakeOAuth;
let mcp: FakeHttpMcp;
let fixture: VerificationServer;
let scratch: string;
const answers: string[] = [];

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: { "content-type": "application/json" },
    redirect: "manual",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(40_000),
  });
  const text = await response.text();
  answers.push(text);
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);

function filesHolding(secret: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (
        stat.isFile()
        && stat.size < 20_000_000
        && path !== fixture.fixtureDumpPath
        && !name.startsWith(CONFIG_BACKUP_PREFIX)
        && readFileSync(path).includes(secret)
      ) {
        found.push(relative(fixture.info.dataDir, path));
      }
    }
  };
  walk(fixture.info.dataDir);
  return found.sort();
}

async function turn(botId: string, calls: unknown[]): Promise<Dump> {
  writeFileSync(join(scratch, "tool-calls.json"), JSON.stringify(calls));
  rmSync(fixture.fixtureDumpPath, { force: true });
  await control(["send", "--bot", botId, "--text", "Check daily OHLCV for AAPL."]);
  await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 20_000 }).toBe(true);
  const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as Dump;
  expect(await control(["wait", "--bot", botId, "--timeout", "40"])).toMatchObject({ status: "settled" });
  return dump;
}

beforeAll(async () => {
  oauth = await startFakeOAuth({ tokenAuthMethods: ["none", "client_secret_basic", "client_secret_post"] });
  mcp = await startFakeHttpMcp({
    acceptBearer: oauth.isValid,
    exactPath: true,
    wellKnown: {
      "/.well-known/oauth-protected-resource/mcp": (origin: string) => ({
        resource: `${origin}/mcp`,
        authorization_servers: [oauth.issuer],
        bearer_methods_supported: ["header"],
      }),
    },
    tools: [
      {
        name: "get_ohlcv",
        description: "Fetch historical OHLCV bars for a symbol",
        inputSchema: { type: "object", properties: { symbol: { type: "string" }, timeframe: { type: "string" } }, required: ["symbol"] },
      },
      {
        name: "search_symbols",
        description: "Search TradingView symbols across asset classes",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      {
        name: "create_alert",
        description: "Create a price alert on the user's TradingView account",
        inputSchema: { type: "object", properties: { symbol: { type: "string" }, price: { type: "number" } }, required: ["symbol", "price"] },
      },
    ],
    callResult: (params) => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, params }) }],
    }),
  });
  scratch = mkdtempSync(join(tmpdir(), "omb-tradingview-e2e-"));
  writeFileSync(join(scratch, "tool-calls.json"), "[]");
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TOOL_CALLS_FILE: join(scratch, "tool-calls.json") });
}, 60_000);

afterAll(async () => {
  await fixture?.close();
  await mcp?.close();
  await oauth?.close();
  rmSync(scratch, { recursive: true, force: true });
});

it("signs into TradingView MCP over OAuth 2.1, activates and deactivates tool access on bot turns, keeps tokens private, and revokes on sign-out", async () => {
  const added = await api("POST", "/api/mcp/servers", { name: "tradingview", type: "http", url: mcp.url, enabled: false });
  expect(added.status).toBe(201);

  const unauthProbe = await api("POST", "/api/mcp/servers/tradingview/test");
  expect(unauthProbe.body).toMatchObject({ ok: false, auth: "required" });

  const started = (await api("POST", "/api/mcp/servers/tradingview/sign-in")).body.auth;
  expect(started).toMatchObject({ phase: "waiting", flowId: expect.any(String) });
  expect(oauth.counts.register).toBe(1);

  const authorize = new URL(started.authorizationUrl);
  expect(authorize.origin + authorize.pathname).toBe(`${oauth.issuer}/authorize`);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("resource")).toBe(mcp.url);

  const callback = (await fetch(authorize, { redirect: "manual" })).headers.get("location")!;
  expect(new URL(callback).hostname).toBe("127.0.0.1");
  expect(await (await fetch(callback)).text()).toContain("Signed in");
  await expect.poll(async () => (await api("GET", `/api/mcp/servers/tradingview/sign-in/${started.flowId}`)).body.auth?.phase).toBe("succeeded");

  const authedProbe = await api("POST", "/api/mcp/servers/tradingview/test");
  expect(authedProbe.body).toMatchObject({
    ok: true,
    tools: expect.arrayContaining([
      expect.objectContaining({ name: "get_ohlcv" }),
      expect.objectContaining({ name: "search_symbols" }),
    ]),
  });
  expect(mcp.calls).toEqual([]);

  const enabled = await api("PATCH", "/api/mcp/servers/tradingview", { enabled: true });
  expect(enabled.body.servers).toEqual([
    expect.objectContaining({ name: "tradingview", url: mcp.url, enabled: true, auth: "signed-in", headerKeys: [] }),
  ]);

  const bot = (await api("POST", "/api/bots", { name: "Chartist" })).body.bot as { id: string };
  const activeDump = await turn(bot.id, [{ name: "mcp__tradingview__get_ohlcv", input: { symbol: "NASDAQ:AAPL", timeframe: "1D" } }]);
  expect(activeDump.mcpConfig.mcpServers.tradingview).toBeDefined();

  const bearer = mcp.seenHeaders.find((headers) => oauth.isValid(headers.authorization))?.authorization?.replace(/^Bearer /, "");
  expect(bearer).toMatch(/^at_/);
  for (const answer of answers) expect(answer).not.toContain(bearer!);
  expect(activeDump.prompt ?? "").not.toContain(bearer!);
  expect(activeDump.systemPrompt ?? "").not.toContain(bearer!);
  expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain(bearer!);
  expect(filesHolding(bearer!)).toEqual(["mcp-oauth.json"]);

  const deactivated = await api("PATCH", "/api/mcp/servers/tradingview", { enabled: false });
  expect(deactivated.body.servers).toEqual([
    expect.objectContaining({ name: "tradingview", enabled: false, auth: "signed-in" }),
  ]);
  const pausedDump = await turn(bot.id, []);
  expect(pausedDump.mcpConfig.mcpServers.tradingview).toBeUndefined();

  await api("PATCH", "/api/mcp/servers/tradingview", { enabled: true });
  const reactivatedDump = await turn(bot.id, []);
  expect(reactivatedDump.mcpConfig.mcpServers.tradingview).toBeDefined();

  const signedOut = await api("POST", "/api/mcp/servers/tradingview/sign-out");
  expect(oauth.counts.revoke).toBeGreaterThan(0);
  expect(signedOut.body.servers).toEqual([
    expect.objectContaining({ name: "tradingview", enabled: true }),
  ]);
  await api("POST", "/api/mcp/servers/tradingview/test");
  expect((await api("GET", "/api/mcp/servers")).body.servers).toEqual([
    expect.objectContaining({ name: "tradingview", auth: "needs-sign-in" }),
  ]);
  const signedOutDump = await turn(bot.id, []);
  expect(signedOutDump.mcpConfig.mcpServers.tradingview).toBeUndefined();
}, 90_000);
