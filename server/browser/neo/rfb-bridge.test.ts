import { createServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DESKTOP_VIEWER_TARGET, viewerTargetId } from "../../../shared/desktop-viewer.ts";
import type { AppConfig } from "../../config.ts";
import type { ContainerComputerStatus } from "../../container-computer.ts";
import { localVmViewerStatus } from "../../desktop-viewer-targets.ts";
import { json, readBody } from "../../harness/http.ts";
import type { RequestAuth } from "../../request-auth.ts";
import { createDesktopViewer } from "../../routes/desktop-viewer.ts";
import { probeRfbPort } from "./rfb-bridge.ts";
import { neoDesktopTarget, neoLocalVmFallback, neoViewerLease, neoVmScreenLive } from "./vm-screen.ts";

function baseStoppedVmStatus(): ContainerComputerStatus {
  return {
    platform: "darwin",
    runtime: null,
    available: [],
    daemonUp: false,
    image: false,
    imageMatches: false,
    managed: false,
    container: "missing",
    network: "unknown",
    security: "unknown",
    persistence: "unknown",
    desktopReady: false,
    desktop_error: null,
    stopped_at: null,
    resumable: false,
    create_supported: true,
    ready: false,
    problem: "No container runtime is installed",
    image_ref: "localhost/openmausbot/cua-local-vm:test",
    image_id: null,
    base_image_ref: "docker.io/trycua/xfce-cua:test",
    driver_version: "0.37.0",
    container_name: "openmausbot-computer",
    target_key: "shared",
    workspace_path: "/tmp/vm-home",
    workspace_guest_path: "/home/cua/workspace",
    viewer_port: null,
    viewer_url: "",
  };
}

describe("BrowserOS neo RFB desktop bridge and Local VM fallback", () => {
  let tempDir: string;
  let rfbServer: NetServer | null = null;
  let httpServer: HttpServer | null = null;
  const sockets = new Set<Socket>();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omb-neo-rfb-"));
  });

  afterEach(async () => {
    for (const sock of sockets) sock.destroy();
    sockets.clear();
    if (rfbServer) {
      const s = rfbServer;
      rfbServer = null;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    if (httpServer) {
      const s = httpServer;
      httpServer = null;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function startRfbMock(onClient?: (socket: Socket) => void): Promise<number> {
    rfbServer = createNetServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      onClient?.(socket);
    });
    await new Promise<void>((resolve) => rfbServer!.listen(0, "127.0.0.1", resolve));
    return (rfbServer.address() as { port: number }).port;
  }

  it("recognizes local/neo in DESKTOP_VIEWER_TARGET and viewerTargetId", () => {
    expect(viewerTargetId({ key: "neo" })).toBe("local/neo");
    expect(DESKTOP_VIEWER_TARGET.test("local/neo")).toBe(true);
  });

  it("probes RFB 003.x ports accurately and rejects non-RFB or closed ports", async () => {
    const rfbPort = await startRfbMock();
    expect(await probeRfbPort("127.0.0.1", rfbPort)).toBe(true);

    const nonRfb = createServer((_req, res) => res.writeHead(200).end("ok"));
    await new Promise<void>((resolve) => nonRfb.listen(0, "127.0.0.1", resolve));
    const nonRfbPort = (nonRfb.address() as { port: number }).port;
    try {
      expect(await probeRfbPort("127.0.0.1", nonRfbPort, 500)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => nonRfb.close(() => resolve()));
    }
  });

  it("bridges raw TCP RFB frames bidirectionally over /api/desktop-viewer/local/neo/websockify", async () => {
    const receivedFromBrowser: Buffer[] = [];
    const rfbPort = await startRfbMock((client) => {
      client.on("data", (chunk: Buffer) => {
        receivedFromBrowser.push(chunk);
        if (chunk.toString("ascii") === "RFB 003.008\n") {
          client.write(Buffer.from([0x01, 0x01]));
        }
      });
    });

    const tokenFile = join(tempDir, "proxy.token");
    writeFileSync(tokenFile, "a".repeat(32));
    const cfg: AppConfig = {
      features: { browserOsNeo: true },
      browserEngine: {
        engine: "browseros-neo",
        neo: {
          url: "http://127.0.0.1:17791",
          tokenFile,
          screen: { vnc: `127.0.0.1:${rfbPort}`, password: "vnc-secret-password" },
        },
      },
    };

    const loopbackAuth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
    const viewer = createDesktopViewer({
      target: (id) => (id === "local/neo" ? neoDesktopTarget(() => cfg, tempDir) : undefined),
      live: () => true,
    });

    httpServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      await viewer.route({
        req,
        res,
        url,
        path: url.pathname,
        method: req.method ?? "GET",
        auth: loopbackAuth,
        json,
        readBody,
      });
    });
    viewer.attach(httpServer, async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      await viewer.route({
        req,
        res,
        url,
        path: url.pathname,
        method: req.method ?? "GET",
        auth: loopbackAuth,
        json,
        readBody,
      });
    });

    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
    const appPort = (httpServer.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${appPort}`;

    const pwRes = await fetch(`${origin}/api/desktop-viewer/local/neo`, {
      headers: { origin },
    });
    expect(pwRes.status).toBe(200);
    expect(await pwRes.json()).toEqual({ password: "vnc-secret-password" });

    const wsFrames: Buffer[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/api/desktop-viewer/local/neo/websockify`, ["binary"], {
      headers: { Origin: origin },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (data, isBinary) => {
        expect(isBinary).toBe(true);
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        wsFrames.push(buf);
        if (wsFrames.length === 1) {
          expect(buf.toString("ascii")).toBe("RFB 003.008\n");
          ws.send(Buffer.from("RFB 003.008\n", "ascii"));
        } else if (wsFrames.length === 2) {
          expect(buf).toEqual(Buffer.from([0x01, 0x01]));
          resolve();
        }
      });
    });

    expect(ws.protocol).toBe("binary");
    expect(Buffer.concat(receivedFromBrowser).toString("ascii")).toBe("RFB 003.008\n");
    ws.close();
    viewer.closeAll();
  });

  it("synthesizes ready Local VM status for Neo VM screen while respecting opt-outs and attached Chrome", async () => {
    const rfbPort = await startRfbMock();
    const cfg: AppConfig = {
      features: { browserOsNeo: true },
      browserProfiles: [{ id: "my-chrome", name: "My Chrome", browser: "chrome" }],
      browserEngine: {
        engine: "browseros-neo",
        neo: {
          url: "http://127.0.0.1:17791",
          token: "b".repeat(32),
          screen: { vnc: `127.0.0.1:${rfbPort}`, password: "pw" },
          optOutBots: ["opted-out-bot"],
        },
      },
    };

    expect(await neoVmScreenLive(cfg, tempDir, { id: "routed-bot" })).toBe(true);
    expect(await neoVmScreenLive(cfg, tempDir, { id: "opted-out-bot" })).toBe(false);
    expect(await neoVmScreenLive(cfg, tempDir, { id: "chrome-bot", browserProfile: "my-chrome" })).toBe(false);

    const fallback = await neoLocalVmFallback(baseStoppedVmStatus(), cfg, tempDir, { id: "routed-bot" });
    expect(fallback.ready).toBe(true);
    expect(fallback.target_key).toBe("neo");
    expect(fallback.viewer_port).toBe(rfbPort);
    expect(fallback.viewer_url).toBe("/desktop-viewer#target=local%2Fneo");

    const loopbackAuth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
    expect(localVmViewerStatus(fallback, loopbackAuth).viewer_url).toBe("/desktop-viewer#target=local%2Fneo");

    const optedOutStatus = await neoLocalVmFallback(baseStoppedVmStatus(), cfg, tempDir, { id: "opted-out-bot" });
    expect(optedOutStatus.ready).toBe(false);

    const leaseFn = neoViewerLease(
      { id: "routed-bot" },
      cfg,
      tempDir,
      "desktop:local/shared",
      "lease-token-12345678",
      (key, leaseId) => key === "routed-bot" && leaseId === "lease-token-12345678",
    );
    expect(leaseFn?.()).toBe(true);
  });
});
