import { existsSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const streamChunks = (res: ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
};

it("discovers Vertex AI from the loopback proxy in an isolated fixture, persists its catalog, and completes turns with effort variants", async () => {
  const seenChats: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
  const proxy = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, project: "ministry-brands-394515", model: "google/gemini-4-carbon", upstream: "global" }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [
          { id: "google/gemini-4-carbon", object: "model", owned_by: "vertex-google" },
          { id: "google/gemini-4-neon", object: "model", owned_by: "vertex-google" },
          { id: "google/gemini-3.8-flash", object: "model", owned_by: "vertex-google" },
          { id: "xai/grok-4.6", object: "model", owned_by: "vertex-xai" },
          { id: "grok-4.6", object: "model", owned_by: "vertex-xai" },
        ],
      }));
      return;
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text) as Record<string, unknown>;
      seenChats.push({ authorization: req.headers.authorization, body });
      if (body.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          model: body.model,
          choices: [{ index: 0, message: { content: "Vertex test title" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        }));
        return;
      }
      streamChunks(res, [
        { choices: [{ index: 0, delta: { content: `VERTEX_FIXTURE_REPLY:${String(body.model)}:${String(body.reasoning_effort ?? "default")}` }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 32, completion_tokens: 12 } },
      ]);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;
  const proxyBaseUrl = `http://127.0.0.1:${proxyPort}/v1`;

  const fixture = await launchVerificationServer({ OMB_VERTEX_URL: proxyBaseUrl });
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;

  try {
    const modelsResult = await cli("models");
    const vertex = modelsResult.instances.find((entry: any) => entry.instanceId === "vertex");
    expect(vertex).toBeDefined();
    expect(vertex).toMatchObject({
      instanceId: "vertex",
      driverKind: "vertex",
      displayName: "Vertex AI",
      snapshot: { state: "available" },
    });
    const fullInstances = (await api("GET", "/api/instances")).instances;
    expect(fullInstances.find((entry: any) => entry.instanceId === "vertex")).toMatchObject({
      instanceId: "vertex",
      driverKind: "vertex",
      snapshot: { state: "available", authenticated: true },
    });
    expect(vertex.models.default).toBe("google/gemini-4-carbon");
    expect(vertex.models.options.map((option: any) => option.id)).toEqual([
      "google/gemini-4-carbon",
      "google/gemini-4-neon",
      "google/gemini-3.8-flash",
      "xai/grok-4.6",
      "grok-4.6",
    ]);
    expect(vertex.models.options.find((option: any) => option.id === "google/gemini-4-neon").variants.map((v: any) => v.id)).toEqual([
      "low", "medium", "high", "xhigh",
    ]);
    expect(vertex.models.options.find((option: any) => option.id === "xai/grok-4.6").variants.map((v: any) => v.id)).toEqual([
      "minimal", "low", "medium", "high", "max",
    ]);

    const cachePath = join(dataDir, "providers", "engine-models", "vertex.json");
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf8")).default).toBe("google/gemini-4-carbon");

    for (const starter of (await api("GET", "/api/bots")).bots.filter((bot: any) => bot.chiefOfStaff)) {
      await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    }
    const bot = (await cli("new-bot", "--name", "Vertex Runner")).bot;
    const threadId: string = bot.activeTaskId ?? bot.threadId;

    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, {
      modelSelection: { instanceId: "vertex", model: "google/gemini-4-neon", variant: "xhigh" },
    });
    await cli("send", "--bot", bot.id, "--task", threadId, "--text", "Say hello from Neon");
    expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "25")).status).toBe("settled");

    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, {
      modelSelection: { instanceId: "vertex", model: "xai/grok-4.6", variant: "max" },
    });
    await cli("send", "--bot", bot.id, "--task", threadId, "--text", "Say hello from Grok");
    expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "25")).status).toBe("settled");

    const streamedTurns = seenChats.filter((call) => call.body.stream === true);
    expect(streamedTurns).toHaveLength(2);
    expect(streamedTurns[0]?.authorization).toBe("Bearer local-vertex-proxy");
    expect(streamedTurns[0]?.body).toMatchObject({
      model: "google/gemini-4-neon",
      max_completion_tokens: 65_536,
      reasoning_effort: "xhigh",
    });
    expect(streamedTurns[1]?.body).toMatchObject({
      model: "xai/grok-4.6",
      max_completion_tokens: 128_000,
      reasoning_effort: "max",
    });

    const messages = (await api("GET", `/api/threads/${threadId}/messages?limit=20`)).messages;
    const botReplies = messages.filter((m: any) => m.role === "bot").map((m: any) => m.text);
    expect(botReplies).toContain("VERTEX_FIXTURE_REPLY:google/gemini-4-neon:xhigh");
    expect(botReplies).toContain("VERTEX_FIXTURE_REPLY:xai/grok-4.6:max");

    const customSecret = "fx-vertex-proxy-token-9876";
    const savedCfg = await api("PUT", "/api/config", { vertex: { baseUrl: proxyBaseUrl, apiKey: customSecret } });
    expect(savedCfg.vertex).toEqual({ configured: true, last4: "9876", baseUrl: proxyBaseUrl });
    expect(JSON.stringify(savedCfg)).not.toContain(customSecret);
  } finally {
    await fixture.close();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}, 90_000);
