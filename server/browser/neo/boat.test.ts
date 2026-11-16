import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BROWSEROS_NEO_PIN } from "./pins.ts";

describe("BrowserOS neo on cloud desktops (boat.dev)", () => {
  let api: Server;
  let dataDir: string;
  let ensureBoatNeo: typeof import("./boat.ts").ensureBoatNeo;
  let forwardBoatNeoCommand: typeof import("./boat.ts").forwardBoatNeoCommand;
  let sleepBoat: typeof import("../../boat.ts").sleepBoat;

  const botId = "neo-cloud-bot";
  const boxId = "bx_23456789";
  let sandboxState = "ready";
  let proxyHealthy = false;
  let neoInstalled = false;
  let proxyInstalled = false;
  let pacInstalled = false;
  let installRuns = 0;
  let startRuns = 0;
  const commands: Array<{ command: string; detached?: boolean }> = [];
  const artifacts = new Map<string, Buffer>();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "omb-neo-boat-test-"));
    const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
    const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "");
    const machineName = `ogb-${prefix}-${hash}`;

    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://boat.test");
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (url.pathname === `/api/v1/sandboxes/${boxId}/artifacts` && req.method === "GET") {
          const filePath = url.searchParams.get("path") ?? "";
          const buf = artifacts.get(filePath);
          if (!buf) {
            res.writeHead(404);
            res.end("not found");
            return;
          }
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(buf.length) });
          res.end(buf);
          return;
        }

        res.writeHead(200, { "content-type": "application/json" });
        if (url.pathname === "/api/v1/sandboxes" && req.method === "GET") {
          res.end(JSON.stringify({ ok: true, sandboxes: [{ id: boxId, name: machineName, state: sandboxState }] }));
          return;
        }
        if (url.pathname === `/api/v1/sandboxes/${boxId}` && req.method === "GET") {
          res.end(JSON.stringify({ ok: true, sandbox: { id: boxId, name: machineName, state: sandboxState } }));
          return;
        }
        if (url.pathname === `/api/v1/sandboxes/${boxId}/resume` && req.method === "POST") {
          sandboxState = "ready";
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (url.pathname === `/api/v1/sandboxes/${boxId}/stop` && req.method === "POST") {
          sandboxState = "archived";
          proxyHealthy = false;
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (url.pathname.startsWith(`/api/v1/sandboxes/${boxId}/commands/`) && req.method === "GET") {
          res.end(JSON.stringify({ running: false, status: "exited", exitCode: 0, stdout: "", stderr: "" }));
          return;
        }
        if (url.pathname === `/api/v1/sandboxes/${boxId}/commands` && req.method === "POST") {
          const parsed = JSON.parse(raw || "{}") as { command: string; detached?: boolean };
          commands.push({ command: parsed.command, detached: parsed.detached });
          const cmd = parsed.command;

          if (parsed.detached) {
            if (cmd.includes("--appimage-extract")) {
              installRuns += 1;
              neoInstalled = true;
            } else {
              startRuns += 1;
              proxyHealthy = true;
            }
            res.end(JSON.stringify({ processId: 400 + installRuns + startRuns }));
            return;
          }
          if (cmd.includes("echo \"ARCH=$(uname -m)\"")) {
            res.end(
              JSON.stringify({
                exitCode: 0,
                stdout: [
                  "ARCH=x86_64",
                  "NODE=v22.14.0",
                  `NEO_INSTALLED=${neoInstalled ? 1 : 0}`,
                  `PROXY_INSTALLED=${proxyInstalled ? 1 : 0}`,
                  `PAC_INSTALLED=${pacInstalled ? 1 : 0}`,
                ].join("\n"),
                stderr: "",
              }),
            );
            return;
          }
          if (cmd.includes("--appimage-extract")) {
            installRuns += 1;
            neoInstalled = true;
            res.end(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));
            return;
          }
          if (cmd.includes("base64 -d") && cmd.includes("omb-browser-proxy-")) {
            proxyInstalled = true;
            res.end(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));
            return;
          }
          if (cmd.includes("base64 -d") && cmd.includes(".pac")) {
            pacInstalled = true;
            res.end(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));
            return;
          }
          if (cmd.includes("/healthz") && !cmd.includes("v1/page-browser")) {
            if (proxyHealthy && proxyInstalled && pacInstalled && neoInstalled) {
              res.end(
                JSON.stringify({
                  exitCode: 0,
                  stdout: '{"ok":true,"browser":"browseros-neo","version":"0.6.0"}\n',
                  stderr: "",
                }),
              );
            } else {
              res.end(JSON.stringify({ exitCode: 7, stdout: "", stderr: "connection refused" }));
            }
            return;
          }
          if (cmd.includes("v1/page-browser")) {
            const payloadMatch = /([A-Za-z0-9+/=]+)(?:'|'\\'') 60000/.exec(cmd);
            const decoded = payloadMatch
              ? (JSON.parse(Buffer.from(payloadMatch[1]!, "base64").toString("utf8")) as Record<string, unknown>)
              : {};
            if (decoded.command === "screenshot") {
              const huge = Buffer.alloc(70_000, "A").toString("utf8");
              const file = "/tmp/omb-neo-reply-big.json";
              artifacts.set(
                file,
                Buffer.from(
                  JSON.stringify({
                    status: 200,
                    body: JSON.stringify({ ok: true, format: "jpeg", mimeType: "image/jpeg", data: huge }),
                  }),
                  "utf8",
                ),
              );
              res.end(JSON.stringify({ exitCode: 0, stdout: `OMB_NEO_FILE:${file}\n`, stderr: "" }));
              return;
            }
            const envelope = Buffer.from(
              JSON.stringify({
                status: 200,
                body: JSON.stringify({ ok: true, url: "https://example.com", title: "Example Domain" }),
              }),
              "utf8",
            ).toString("base64");
            res.end(JSON.stringify({ exitCode: 0, stdout: `OMB_NEO_INLINE:${envelope}\n`, stderr: "" }));
            return;
          }
          if (cmd.includes("rm -f '/tmp/omb-neo-reply-big.json'")) {
            artifacts.delete("/tmp/omb-neo-reply-big.json");
          }
          res.end(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as AddressInfo).port;
    vi.stubEnv("OMB_DATA_DIR", dataDir);
    vi.stubEnv("OMB_BOAT_API", `http://127.0.0.1:${port}/api/v1`);
    vi.resetModules();
    ({ ensureBoatNeo, forwardBoatNeoCommand } = await import("./boat.ts"));
    ({ sleepBoat } = await import("../../boat.ts"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("matches deploy/computer-vm/image-pin.json byte-for-byte", () => {
    const imagePin = JSON.parse(
      readFileSync(new URL("../../../deploy/computer-vm/image-pin.json", import.meta.url), "utf8"),
    ) as { browserosNeo: typeof BROWSEROS_NEO_PIN };
    expect(BROWSEROS_NEO_PIN).toEqual(imagePin.browserosNeo);
  });

  it("installs once, reuses fast-path when healthy, restarts after archive/resume without re-downloading, and forwards inline + large replies", async () => {
    const cfg = { box: { token: "boat_test_token" } } as any;
    let usedCount = 0;

    const id1 = await ensureBoatNeo(cfg, botId, { onUsed: () => (usedCount += 1) });
    expect(id1).toBe(boxId);
    expect(installRuns).toBe(1);
    expect(startRuns).toBe(1);
    expect(usedCount).toBe(1);

    const beforeFast = commands.length;
    const id2 = await ensureBoatNeo(cfg, botId, { onUsed: () => (usedCount += 1) });
    expect(id2).toBe(boxId);
    expect(installRuns).toBe(1);
    expect(startRuns).toBe(1);
    expect(commands.length - beforeFast).toBe(1);

    const inlineReply = await forwardBoatNeoCommand(cfg, botId, "bot-1:thread-1", {
      command: "navigate",
      url: "https://example.com",
    });
    expect(inlineReply).toEqual({
      status: 200,
      body: { ok: true, url: "https://example.com", title: "Example Domain" },
    });

    const largeReply = await forwardBoatNeoCommand(cfg, botId, "bot-1:thread-1", {
      command: "screenshot",
      format: "jpeg",
    });
    expect(largeReply.status).toBe(200);
    expect(largeReply.body.ok).toBe(true);
    expect(String(largeReply.body.data).length).toBe(70_000);

    commands.length = 0;
    await sleepBoat(cfg, botId);
    const quiesceCmd = commands[0]?.command ?? "";
    expect(quiesceCmd).toContain("browserclaw");
    expect(quiesceCmd).toContain("BrowserClawServer");
    expect(sandboxState).toBe("archived");

    await ensureBoatNeo(cfg, botId);
    expect(sandboxState).toBe("ready");
    expect(installRuns).toBe(1);
    expect(startRuns).toBe(2);
  });
});
