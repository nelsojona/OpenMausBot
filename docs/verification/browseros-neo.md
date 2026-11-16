# BrowserOS neo proxy, VM screen and slash skill

Build the client and run the isolated end-to-end verification fixture:

```sh
pnpm build
node --experimental-strip-types scripts/verify-browseros-neo.ts
```

Pass `--park` to keep the isolated server, proxy and synthetic RFB desktop open
for interactive inspection at desktop width (`1512x982`) until Ctrl-C or
`SIGTERM`:

```sh
node --experimental-strip-types scripts/verify-browseros-neo.ts --park
```

The fixture runs `scripts/verify-browseros-neo.ts` against an isolated
`launchVerificationServer` instance (`scripts/control-omb.ts`) with a disposable
data directory, a real `deploy/computer-vm/guest/omb-browser-proxy.mjs` child
process authenticated by a generated 64-hex token file, a synthetic BrowserOS
neo Streamable HTTP MCP server (`browserclaw` wire contract), and a loopback
raw-TCP RFB 3.8 server. It never touches `~/.openmausbot`, live QEMU VMs, or a
live `boat.dev` account.

## What the fixture proves

- Enabling `features.browserOsNeo` and `browserEngine.engine = "browseros-neo"`
  via `/api/config` routes default bots (`Atlas`) to `server/browser/neo/engine.ts`
  while keeping opted-out bots (`LocalControl`, set to `"local"` in
  `browser-proxies.json`) on the local engine with zero calls to
  `omb-browser-proxy.mjs`.
- Sending `/browseros-neo Verify https://example.com/neo-check` via
  `pnpm control:omb send` and waiting via `pnpm control:omb wait` expands
  `skills/browseros-neo/SKILL.md` in the turn prompt (`server/host/skills-library.ts`)
  and mounts the narrowed browser MCP toolset (`agent_browser_status`,
  `agent_browser_open`, `agent_browser_snapshot`, `agent_browser_click`,
  `agent_browser_read` — excluding `agent_browser_eval` and
  `agent_browser_upload`).
- `agent_browser_status` reports `Browser: BrowserOS neo (VM proxy)`, satisfying
  the skill's unforgeable routing guard before `## Steps`.
- `omb-browser-proxy.mjs` blocks private, loopback and link-local navigations
  (`http://169.254.169.254/latest/meta-data`) before reaching the MCP server,
  unwraps `[UNTRUSTED_PAGE_CONTENT nonce=...]` boundaries, and writes JSONL
  audit records without leaking the bearer token.
- `/api/bots/{id}/computer` and `/api/bots/{id}/local-computer` resolve
  `surface: "vm"`, `target_key: "neo"`, and `/desktop-viewer#target=local%2Fneo`
  when the Neo VM RFB screen is reachable, while leaving opted-out bots off the
  `neo` desktop target.
- Taking control via `/api/bots/{id}/computer/control` and joining via
  `/api/bots/{id}/local-computer/join` bridges raw TCP RFB 3.8 frames over
  `/api/desktop-viewer/local/neo/websockify` (`server/browser/neo/rfb-bridge.ts`)
  and `/api/desktop-viewer/local/neo`, while `/api/bots/{id}/local-computer/screenshot`
  captures the VM preview frame.
- `/api/bots/{id}/browser/live` streams `event: status` (`https://example.com/neo-check`)
  and `event: frame` SSE updates (`server/browser/neo/live.ts`) to
  `src/components/BrowserPanel.tsx`, and typing `/browser` in
  `src/components/Composer.tsx` surfaces `/browseros-neo` (`src/lib/composer-commands.ts`)
  when BrowserOS neo is active.

## Focused unit and integration suites

```sh
pnpm exec vitest run server/browser/neo/pac.test.ts server/browser/neo/proxy.test.ts server/browser/neo/boat.test.ts server/browser/neo/engine.test.ts server/browser/neo/rfb-bridge.test.ts server/skill-browseros-neo.test.ts src/lib/composer-commands.test.ts
pnpm exec vitest run scripts/testing/verification-docs.test.ts
pnpm test:packaged-server
```

## Scope and limitations

- The local VM recipe (`deploy/computer-vm/`) provisions an Omarchy Server guest
  under QEMU (`vm-provision.sh`, `vm-up.sh`, `vm-verify.sh`) with pinned
  upstream artifacts (`deploy/computer-vm/pins.env`, `server/browser/neo/pins.ts`)
  and PostHog PAC sinkholing (`deploy/computer-vm/guest/posthog-block.pac`).
  The automated fixture exercises the real proxy and server routes against
  synthetic MCP and RFB endpoints rather than booting QEMU in CI.
- On `boat.dev` cloud desktops (`server/browser/neo/boat.ts`, `server/boat.ts`),
  BrowserOS neo and `omb-browser-proxy.mjs` are provisioned lazily on
  `DISPLAY=:0` with SHA-256 verification and loopback-only binding, verified
  offline against a mocked `boat.dev` command runner in
  `server/browser/neo/boat.test.ts`.
