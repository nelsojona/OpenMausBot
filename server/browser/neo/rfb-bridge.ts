// Raw RFB 3.x (RFC 6143) TCP-to-WebSocket bridge for QEMU/wayvnc VM screens that do not run a guest websockify HTTP server.
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { PendingUpgrade } from "../../routes/upgrades.ts";

const HANDSHAKE_MS = 10_000;
const RECHECK_MS = 5_000;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const RFB_PREFIX = Buffer.from("RFB 003.", "ascii");

const rfbUpgradeServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: MAX_PAYLOAD_BYTES,
  handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : [...protocols][0] ?? false),
});

export function probeRfbPort(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let received: Buffer = Buffer.alloc(0);
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref();
    socket.on("error", () => done(false));
    socket.on("close", () => done(false));
    socket.on("data", (chunk: Buffer) => {
      received = received.length === 0 ? chunk : Buffer.concat([received, chunk]);
      if (received.length >= RFB_PREFIX.length) {
        done(received.subarray(0, RFB_PREFIX.length).equals(RFB_PREFIX));
      }
    });
  });
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export interface RfbBridgeOptions {
  req: IncomingMessage;
  res: ServerResponse;
  pending: PendingUpgrade;
  host: string;
  port: number;
  live: () => boolean;
  holds: () => boolean;
  touch?: () => void;
  retain?: () => () => void;
  onRegisterClose: (close: () => void) => void;
  json: (res: ServerResponse, status: number, body: unknown) => void;
}

export function bridgeRfbWebSocket(options: RfbBridgeOptions): void {
  const { req, res, pending, host, port, live, holds, touch, retain, onRegisterClose, json } = options;
  const tcp: Socket = connect({ host, port });
  tcp.setNoDelay(true);
  const release = retain?.();
  const earlyChunks: Buffer[] = [];
  let ws: WebSocket | undefined;
  let upgraded = false;
  let closed = false;
  let recheck: ReturnType<typeof setInterval> | undefined;
  let drainCheck: ReturnType<typeof setInterval> | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    release?.();
    clearTimeout(timeout);
    clearInterval(recheck);
    clearInterval(drainCheck);
    tcp.destroy();
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close(); } catch { ws.terminate(); }
    } else if (ws) {
      ws.terminate();
    }
    pending.socket.destroy();
  };
  onRegisterClose(close);

  const fail = () => {
    if (closed) return;
    if (upgraded || pending.socket.destroyed) {
      close();
      return;
    }
    if (!res.headersSent && !pending.socket.destroyed) {
      json(res, 502, { error: "Could not connect to the desktop viewer" });
    }
    close();
  };

  const timeout = setTimeout(fail, HANDSHAKE_MS);
  timeout.unref();

  pending.socket.once("close", close);
  tcp.on("error", () => (upgraded ? close() : fail()));
  tcp.once("close", () => (upgraded ? close() : fail()));

  tcp.on("data", (chunk: Buffer) => {
    if (closed) return;
    if (!ws) {
      earlyChunks.push(chunk);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES && !tcp.isPaused()) {
      tcp.pause();
      if (!drainCheck) {
        drainCheck = setInterval(() => {
          if (closed || !ws || ws.readyState !== WebSocket.OPEN) {
            clearInterval(drainCheck);
            drainCheck = undefined;
            return;
          }
          if (ws.bufferedAmount <= MAX_BUFFERED_BYTES / 2) {
            clearInterval(drainCheck);
            drainCheck = undefined;
            tcp.resume();
          }
        }, 25);
        drainCheck.unref();
      }
    }
  });

  tcp.once("connect", () => {
    if (closed) return;
    if (!live() || !holds() || pending.socket.destroyed || res.destroyed) {
      fail();
      return;
    }
    clearTimeout(timeout);
    upgraded = true;
    pending.release();
    const head = pending.head;
    pending.head = Buffer.alloc(0);
    rfbUpgradeServer.handleUpgrade(req, pending.socket, head, (socket) => {
      if (closed || !live() || !holds()) {
        socket.terminate();
        close();
        return;
      }
      ws = socket;
      pending.socket.setKeepAlive(true, 15_000);
      touch?.();
      for (const chunk of earlyChunks.splice(0)) {
        if (socket.readyState === WebSocket.OPEN) socket.send(chunk, { binary: true });
      }
      socket.on("error", close);
      socket.once("close", close);
      socket.on("message", (data: RawData) => {
        if (closed || tcp.destroyed) return;
        if (!live() || !holds()) {
          close();
          return;
        }
        tcp.write(toBuffer(data));
      });
      recheck = setInterval(() => {
        if (!live() || !holds()) close();
        else touch?.();
      }, RECHECK_MS);
      recheck.unref();
    });
    res.detachSocket(pending.socket);
  });
}
