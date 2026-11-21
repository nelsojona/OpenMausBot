# TradingView connection

The built-in TradingView card in Plugins connects to TradingView's official
hosted MCP endpoint (`https://mcp.tradingview.com/mcp`) over Streamable HTTP
using OAuth 2.1 browser sign-in (`https://www.tradingview.com/mcp/oauth/authorize`),
dynamic client registration and PKCE S256, with no pasted API key or Composio
dependency.

## Isolated checks

```sh
pnpm exec vitest run server/tradingview.e2e.test.ts server/mcp-oauth-discovery.test.ts src/lib/hosted-mcp-apps.test.ts src/components/PluginsPanel.navigation.test.ts src/components/PluginsPanel.i18n.test.ts src/components/McpServersPanel.embedded.test.ts src/components/McpServersPanel.hosted.test.ts scripts/testing/verification-docs.test.ts
```

`server/tradingview.e2e.test.ts` launches a disposable fake-engine workspace
beside synthetic cross-origin OAuth and Streamable HTTP MCP servers shaped like
`mcp.tradingview.com` and `www.tradingview.com`, and checks:

- RFC 9728 protected-resource discovery, dynamic client registration, PKCE S256
  sign-in, tool discovery (`get_ohlcv`, `search_symbols`) without running any
  tool during setup, and enabling `/api/mcp/servers/tradingview`;
- a bot turn mounting `tradingview` and calling `mcp__tradingview__get_ohlcv`
  with the bearer token, while the token stays out of every API response,
  transcript, prompt, log and data file other than `mcp-oauth.json`;
- toggling `enabled` off and back on via `PATCH /api/mcp/servers/tradingview`
  without losing the saved sign-in;
- signing out via `POST /api/mcp/servers/tradingview/sign-out`, revoking the
  token and returning the entry to `needs-sign-in`.

## Isolated browser verification

Set `OMB_VERIFY_PLAYWRIGHT` to an installed Playwright module entry and
`OMB_VERIFY_BROWSER_CHROME` to a Chromium/Chrome executable if Playwright cannot
resolve its own browser, then run:

```sh
node --experimental-strip-types scripts/verify-tradingview.ts
```

This drives the real Plugins modal against a disposable server and synthetic
OAuth/MCP providers across Midnight (`1512×900`), Daylight (`1512×900`),
`1440×900` and narrow (`390×844`) viewports, checking:

- the neutral candlestick glyph (no unlicensed logo) and keyless OAuth card;
- preserving an existing unrelated `tradingview` command server;
- cancellation, denied consent and post-login tool discovery refusal (such as
  an ineligible plan returning HTTP 403) leaving the server off and retryable;
- successful consent enabling the connection, updating the Connected filter and
  count, toggling activation in **Plugins → MCP servers**, keyword search, and
  disconnecting with token revocation.

Screenshots default to `/tmp/omb-tradingview-evidence`; override with
`OMB_UI_EVIDENCE_DIR`. This proves the integration mechanics, **not a live
TradingView account**.

## Live acceptance (TradingView Essential+ account required)

1. Open **Plugins → TradingView → Connect**. Sign in on TradingView and approve
   access; verify the card shows Connected (note: TradingView includes MCP on
   Essential plans and higher, not free or trial plans).
2. Ask a permitted bot to search a symbol or read daily OHLCV bars.
3. Open **Plugins → MCP servers** and toggle **TradingView** off and back on to
   verify activation switching without signing in again.
4. Click **Disconnect** on the TradingView card and verify a new turn no longer
   mounts `tradingview`.
