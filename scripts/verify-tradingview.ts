// Isolated browser verification for the TradingView card in Plugins: real registry, OAuth and renderer, synthetic endpoints only.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer } from "./control-omb.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { startFakeOAuth } from "../server/testing/fake-oauth-server.ts";
import { startFakeHttpMcp } from "../server/testing/fake-http-mcp-server.ts";

const OFFICIAL_URL = "https://mcp.tradingview.com/mcp";
const fixture = await launchVerificationServer();
const oauth = await startFakeOAuth({ tokenAuthMethods: ["none", "client_secret_basic", "client_secret_post"] });
const mcp = await startFakeHttpMcp({
  acceptBearer: oauth.isValid,
  wwwAuthenticate: oauth.challenge,
  exactPath: true,
  tools: [
    { name: "get_ohlcv", inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
    { name: "search_symbols", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  ],
});

let ui: MountedPreview | undefined;
let browser: { close(): Promise<void> } | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  await api("POST", "/api/mcp/servers", { name: "tradingview", command: "node", args: ["unrelated-local.mjs"], enabled: false });
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  let authorizationUrl = "";
  let failTest = false;

  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/whop-preview.tsx",
    route: "/__tradingview.html",
    title: "Isolated TradingView integration",
    extraRoutes: [
      {
        path: "/api/connectors/catalog",
        handler: (_req, res) => {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            configured: false,
            mode: "self-hosted",
            source: "curated",
            cards: ["gmail", "slack", "notion"].map((slug) => ({
              slug,
              label: slug === "gmail" ? "Gmail" : slug[0]!.toUpperCase() + slug.slice(1),
              blurb: "Connect your account",
              logo: null,
              domain: null,
            })),
          }));
        },
      },
      {
        path: /^\/api\/connectors(?:\/connected)?$/,
        handler: (_req, res) => {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ services: {} }));
        },
      },
      {
        path: /^\/api\/mcp\/servers(?:\/.*)?$/,
        handler: async (req, res) => {
          const path = req.url!;
          if (req.method === "POST" && path.endsWith("/test") && failTest) {
            failTest = false;
            res.writeHead(200, { "content-type": "application/json" }).end('{"ok":false,"error":"HTTP 403"}');
            return;
          }
          let raw = "";
          for await (const chunk of req) raw += chunk;
          if (raw) {
            const body = JSON.parse(raw);
            if (body.url === OFFICIAL_URL) body.url = mcp.url;
            raw = JSON.stringify(body);
          }
          const response = await fetch(`${fixture.info.url}${path}`, {
            method: req.method,
            headers: { "content-type": "application/json", cookie: req.headers.cookie ?? "", "x-forwarded-for": "192.0.2.10" },
            ...(raw ? { body: raw } : {}),
          });
          const body = await response.json();
          for (const server of body.servers ?? []) {
            if (server.url === mcp.url) server.url = OFFICIAL_URL;
          }
          if (req.method === "POST" && path.endsWith("/sign-in") && response.ok) {
            authorizationUrl = body.auth.authorizationUrl;
            body.auth.authorizationUrl = "https://www.tradingview.com/mcp/oauth/authorize?synthetic=1";
          }
          res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(body));
        },
      },
    ],
  });

  const { chromium } = await import(process.env.OMB_VERIFY_PLAYWRIGHT || "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OMB_VERIFY_BROWSER_CHROME || undefined });
  const context = await (browser as any).newContext({ viewport: { width: 1512, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript(() => { window.open = () => null; });
  await page.goto(ui.previewUrl);
  assert.equal(
    await page.evaluate(
      async (code: string) => (await fetch("/api/auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, cookie: true, label: "TradingView fixture" }),
      })).status,
      pairing.code,
    ),
    200,
  );
  await page.reload();

  const row = page.locator('[data-app-tile="tradingview"]');
  await row.waitFor();
  assert.equal(await row.locator("img").count(), 0, "TradingView uses a neutral candlestick glyph, never an unlicensed logo");
  assert.equal(await row.locator("svg").count() >= 1, true);
  assert.equal(await row.locator("input").count(), 0, "TradingView signs in with browser OAuth, not a pasted key");

  const connect = () => row.getByRole("button", { name: "Connect TradingView", exact: true }).click();
  const status = async () => (await api("GET", "/api/mcp/servers")).servers;
  const pasteBack = () => page.getByText("After you approve, your browser shows a page that can't load. Copy that page's full address and paste it here.", { exact: true });
  const complete = async () => {
    await pasteBack().waitFor();
    const approved = await fetch(authorizationUrl, { redirect: "manual" });
    await page.getByRole("textbox", { name: "Redirect URL", exact: true }).fill(approved.headers.get("location")!);
    await page.getByRole("button", { name: "Complete sign-in", exact: true }).click();
  };

  await connect();
  await pasteBack().waitFor();
  assert.equal((await status()).find((server: any) => server.name === "tradingview-2").enabled, false);
  assert.equal((await status()).find((server: any) => server.name === "tradingview").command, "node");
  await row.getByRole("button", { name: "Cancel", exact: true }).click();

  oauth.options.deny = true;
  await connect();
  await complete();
  await row.getByRole("button", { name: "Connect TradingView", exact: true }).waitFor();
  assert.equal((await status()).length, 2, "Retry reuses tradingview-2 without adding duplicates");
  assert.equal((await status()).find((server: any) => server.name === "tradingview-2").enabled, false);
  oauth.options.deny = false;

  failTest = true;
  await connect();
  await complete();
  await page.getByText("Signed in, but TradingView’s tools could not be loaded: HTTP 403. Please connect again to retry.", { exact: true }).waitFor();
  assert.equal((await status()).find((server: any) => server.name === "tradingview-2").enabled, false);

  await connect();
  await complete();
  await row.getByLabel("Connected", { exact: true }).waitFor();
  const connected = (await status()).find((server: any) => server.name === "tradingview-2");
  assert.equal(connected.auth, "signed-in");
  assert.equal(connected.enabled, true);
  assert.equal(mcp.calls.length, 0);

  const output = process.env.OMB_UI_EVIDENCE_DIR || "/tmp/omb-tradingview-evidence";
  mkdirSync(output, { recursive: true });
  await page.evaluate(() => localStorage.setItem("omb-skin", "midnight"));
  await page.reload();
  await row.getByLabel("Connected", { exact: true }).waitFor();
  await row.locator("details summary").click();
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "midnight-desktop-1512.png"), fullPage: true });

  await page.evaluate(() => localStorage.setItem("omb-skin", "daylight"));
  await page.reload();
  await row.getByLabel("Connected", { exact: true }).waitFor();
  await row.locator("details summary").click();
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "daylight-desktop-1512.png"), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  await page.locator('[data-apps-filter="connected"]').click();
  await row.getByLabel("Connected", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-apps-filter="connected"]').innerText(), "1 connected");

  await page.locator('[data-apps-filter="mcp"]').click();
  const mcpRow = page.locator('[data-hosted-server="tradingview"]');
  await mcpRow.waitFor();
  await page.setViewportSize({ width: 1512, height: 900 });
  await mcpRow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "mcp-servers-1512.png"), fullPage: true });

  const toggle = mcpRow.getByRole("switch");
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-hosted-server="tradingview"] [role="switch"]')?.getAttribute("aria-checked") === "false");
  assert.equal((await status()).find((server: any) => server.name === "tradingview-2").enabled, false);
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-hosted-server="tradingview"] [role="switch"]')?.getAttribute("aria-checked") === "true");
  assert.equal((await status()).find((server: any) => server.name === "tradingview-2").enabled, true);

  await page.locator('[data-apps-filter="all"]').click();
  const search = page.getByRole("textbox", { name: "Search apps", exact: true });
  await search.fill("candlesticks");
  assert.equal(await row.isVisible(), true);
  assert.equal(await page.locator('[data-app-tile="whop"]').isVisible(), false);
  await search.fill("");

  await row.getByRole("button", { name: "Disconnect TradingView", exact: true }).click();
  await row.getByRole("button", { name: "Connect TradingView", exact: true }).waitFor();
  assert.equal((await status()).find((server: any) => server.name === "tradingview-2").enabled, false);
  assert.ok(oauth.counts.revoke > 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "narrow-390.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, ...fixture.info, evidence: output, liveTradingViewAccountTested: false }));
} finally {
  await browser?.close();
  await ui?.close();
  await mcp.close();
  await oauth.close();
  await fixture.close();
}
