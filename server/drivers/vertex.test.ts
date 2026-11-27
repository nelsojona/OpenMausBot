import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { readStartupModelCache, startupModelCachePath } from "../startup-model-catalog.ts";
import { recordEvents } from "../testing/events.ts";
import { ChatToolCalls, replayableToolCalls } from "./openai-chat-protocol.ts";
import { classifyError } from "./retry.ts";
import {
  createVertexFetch,
  probeVertexHealth,
  splitVertexModelId,
  VERTEX_DEFAULT_BASE_URL,
  VERTEX_KNOWN_MODELS,
  VERTEX_PLACEHOLDER_API_KEY,
  VERTEX_RETRY_CAP_MS,
  VERTEX_RETRY_SCHEDULE_MS,
  vertexCatalogFromModels,
  VertexDriver,
  vertexMaxCompletionTokens,
  vertexModelOption,
  vertexPlainRefusal,
  vertexProxyOrigin,
  vertexReasoningEffort,
  vertexRequestBody,
  vertexRetryAfterMs,
  vertexRetryDelayMs,
} from "./vertex.ts";

type ChatBody = {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: unknown[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_completion_tokens?: number;
  reasoning_effort?: string;
};

const streamChunks = (res: ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
};

describe("Vertex AI driver — unit contracts", () => {
  it("applies default baseUrl and placeholder key, normalizes trailing slashes, and blocks non-loopback HTTP", () => {
    expect(VertexDriver.defaultConfig()).toEqual({ baseUrl: VERTEX_DEFAULT_BASE_URL });
    expect(VERTEX_DEFAULT_BASE_URL).toBe("http://127.0.0.1:18790/v1");
    expect(VERTEX_PLACEHOLDER_API_KEY).toBe("local-vertex-proxy");
    expect(VertexDriver.decodeConfig({ baseUrl: "http://localhost:18790/v1///" })).toEqual({
      baseUrl: "http://localhost:18790/v1",
    });
    expect(VertexDriver.decodeConfig({ url: "https://vertex-proxy.example.test/v1/", apiKey: "custom-key" })).toEqual({
      baseUrl: "https://vertex-proxy.example.test/v1",
      apiKey: "custom-key",
    });
    expect(() => VertexDriver.decodeConfig({ baseUrl: "http://remote.example.test:18790/v1" })).toThrow("loopback HTTP proxy or HTTPS");
    expect(vertexProxyOrigin("http://127.0.0.1:18790/v1/")).toBe("http://127.0.0.1:18790");
    expect(vertexProxyOrigin("http://127.0.0.1:18790")).toBe("http://127.0.0.1:18790");
  });

  it("splits model ids on the first slash only", () => {
    expect(splitVertexModelId("google/gemini-4-carbon")).toEqual({ publisher: "google", name: "gemini-4-carbon" });
    expect(splitVertexModelId("google/experimental/gemini-next")).toEqual({ publisher: "google", name: "experimental/gemini-next" });
    expect(splitVertexModelId("grok-4.6")).toEqual({ name: "grok-4.6" });
  });

  it("maps known, legacy, and unknown /v1/models rows with accurate labels, context windows, and variants", () => {
    const catalog = vertexCatalogFromModels([
      { id: "grok-4.5", object: "model" },
      { id: "google/gemini-4-carbon", object: "model", owned_by: "vertex-google" },
      { id: "google/gemini-4-argon", object: "model" },
      { id: "google/gemini-4-hydrogen", object: "model" },
      { id: "google/gemini-4-neon", object: "model" },
      { id: "google/gemini-3.8-flash", object: "model" },
      { id: "xai/grok-4.6", object: "model", owned_by: "vertex-xai" },
      { id: "xai/grok-4.7", object: "model", owned_by: "vertex-xai" },
      { id: "grok-4.6", object: "model" },
      { id: "future-org/mystery-model", object: "model", context_length: 256_000 },
      { id: "bare-future-model", object: "model" },
      { id: "google/gemini-4-carbon", object: "model" },
    ]);

    expect(catalog.default).toBe("google/gemini-4-carbon");
    const byId = new Map(catalog.options.map((option) => [option.id, option]));

    expect(byId.get("google/gemini-4-carbon")).toEqual({
      id: "google/gemini-4-carbon",
      label: "Gemini 4 Carbon (Vertex)",
      contextWindow: 1_048_576,
      variants: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
    });
    expect(byId.get("google/gemini-4-hydrogen")?.variants?.map((v) => v.id)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(byId.get("google/gemini-4-neon")?.variants?.map((v) => v.id)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(byId.get("google/gemini-3.8-flash")?.variants?.map((v) => v.id)).toEqual(["low", "medium", "high"]);
    expect(byId.get("xai/grok-4.6")).toEqual({
      id: "xai/grok-4.6",
      label: "Grok 4.6 (Vertex GCP)",
      contextWindow: 500_000,
      variants: [
        { id: "minimal", label: "Minimal" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
    });
    expect(byId.get("xai/grok-4.7")?.label).toBe("Grok 4.7 (Vertex GCP)");
    expect(byId.get("grok-4.6")?.label).toBe("grok-4.6 (legacy id)");
    expect(byId.get("grok-4.5")?.label).toBe("grok-4.5 (legacy id)");
    expect(byId.get("future-org/mystery-model")).toEqual({
      id: "future-org/mystery-model",
      label: "future-org/mystery-model",
      contextWindow: 256_000,
    });
    expect(byId.get("bare-future-model")).toEqual({
      id: "bare-future-model",
      label: "bare-future-model",
    });
    expect(byId.get("future-org/mystery-model")?.variants).toBeUndefined();
    expect(byId.get("bare-future-model")?.variants).toBeUndefined();
  });

  it("enforces per-family effort enums and max_completion_tokens without guessing on unknown models", () => {
    for (const grokId of ["xai/grok-4.6", "xai/grok-4.7", "grok-4.6", "grok-4.5"]) {
      expect(vertexReasoningEffort(grokId, "xhigh")).toBeUndefined();
      expect(vertexRequestBody(grokId, [], true, "xhigh")).not.toHaveProperty("reasoning_effort");
      for (const valid of ["minimal", "low", "medium", "high", "max"] as const) {
        expect(vertexReasoningEffort(grokId, valid)).toBe(valid);
        expect(vertexRequestBody(grokId, [], true, valid)).toMatchObject({
          model: grokId,
          max_completion_tokens: 128_000,
          reasoning_effort: valid,
          stream_options: { include_usage: true },
        });
      }
    }

    for (const geminiId of [
      "google/gemini-4-carbon",
      "google/gemini-4-argon",
      "google/gemini-4-hydrogen",
      "google/gemini-4-neon",
      "google/gemini-3.8-flash",
    ]) {
      expect(vertexReasoningEffort(geminiId, "minimal")).toBeUndefined();
      expect(vertexReasoningEffort(geminiId, "max")).toBeUndefined();
      expect(vertexRequestBody(geminiId, [], true, "minimal")).not.toHaveProperty("reasoning_effort");
      expect(vertexRequestBody(geminiId, [], true, "max")).not.toHaveProperty("reasoning_effort");
      expect(vertexMaxCompletionTokens(geminiId)).toBe(65_536);
      expect(VERTEX_KNOWN_MODELS.get(geminiId)?.maxTokens).toBe(65_536);
    }

    expect(vertexReasoningEffort("google/gemini-4-carbon", "xhigh")).toBeUndefined();
    expect(vertexReasoningEffort("google/gemini-4-argon", "xhigh")).toBeUndefined();
    expect(vertexReasoningEffort("google/gemini-3.8-flash", "xhigh")).toBeUndefined();
    expect(vertexReasoningEffort("google/gemini-4-hydrogen", "xhigh")).toBe("xhigh");
    expect(vertexReasoningEffort("google/gemini-4-neon", "xhigh")).toBe("xhigh");

    const unknownBody = vertexRequestBody("unknown/model-x", [], false, "high");
    expect(unknownBody).toEqual({ model: "unknown/model-x", messages: [], stream: false });
    expect(vertexModelOption("unknown/model-x").variants).toBeUndefined();
  });

  it("computes 429 retry delays (0/5/15/30 s capped at 60 s, honoring Retry-After) and classifies 401/429/404", () => {
    expect(VERTEX_RETRY_SCHEDULE_MS).toEqual([0, 5_000, 15_000, 30_000]);
    expect(VERTEX_RETRY_CAP_MS).toBe(60_000);
    expect([0, 1, 2, 3].map((attempt) => vertexRetryDelayMs(attempt))).toEqual([0, 5_000, 15_000, 30_000]);
    expect(vertexRetryDelayMs(0, "12")).toBe(12_000);
    expect(vertexRetryDelayMs(1, "120")).toBe(60_000);
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(vertexRetryAfterMs("Fri, 20 Nov 2026 12:00:08 GMT", now)).toBe(8_000);
    expect(vertexRetryDelayMs(0, "Fri, 20 Nov 2026 12:02:30 GMT", now)).toBe(60_000);

    expect(classifyError(new Error("Vertex AI HTTP 401: Invalid proxy bearer"))).toEqual({
      transient: false,
      reason: "auth",
    });
    expect(classifyError(new Error("Vertex AI HTTP 429: Resource exhausted"))).toEqual({
      transient: true,
      reason: "rate_limited",
    });

    const regional404 = vertexPlainRefusal(
      404,
      JSON.stringify({
        error: {
          code: 404,
          message: "Publisher Model `projects/ministry-brands-394515/locations/us-east4/publishers/google/models/gemini-4-carbon` was not found.",
          status: "NOT_FOUND",
        },
      }),
    );
    expect(regional404).toContain("global endpoint");
    expect(classifyError(new Error(regional404!))).toEqual({
      transient: false,
      reason: "unknown_model",
    });
  });

  it("preserves Gemini extra_content.google.thought_signature across ChatToolCalls and replayableToolCalls", () => {
    const signature = {
      google: { thought_signature: "Et8BCtwBAdH+signature+opaque==" },
      vendor_meta: { step: 2 },
    };
    const streamed = new ChatToolCalls();
    streamed.add(
      [{ index: 0, id: "call_sig_1", type: "function", function: { name: "lookup_status", arguments: '{"id":' }, extra_content: signature }],
      true,
    );
    streamed.add([{ index: 0, function: { arguments: '"42"}' } }], true);
    const finished = streamed.finish("tool_calls", false);
    expect(finished).toEqual([
      {
        id: "call_sig_1",
        type: "function",
        function: { name: "lookup_status", arguments: '{"id":"42"}' },
        extra_content: signature,
      },
    ]);
    expect(replayableToolCalls(finished)).toEqual(finished);
  });
});

describe("Vertex AI driver — fake proxy integration", () => {
  let server: Server;
  let port: number;
  let baseUrl: string;
  let healthStatus: number;
  let healthBody: unknown;
  let healthPathMode: "root" | "v1";
  let modelsBody: unknown;
  let chatHandler: (body: ChatBody, res: ServerResponse, attempt: number) => void;
  let requests: Array<{ method: string; path: string; authorization?: string; body?: ChatBody }>;
  let instances: ProviderInstance[];

  beforeEach(async () => {
    requests = [];
    instances = [];
    healthStatus = 200;
    healthPathMode = "root";
    healthBody = { ok: true, project: "ministry-brands-394515", model: "google/gemini-4-carbon", upstream: "global" };
    modelsBody = {
      object: "list",
      data: [
        { id: "google/gemini-4-carbon", object: "model", owned_by: "vertex-google" },
        { id: "google/gemini-4-neon", object: "model", owned_by: "vertex-google" },
        { id: "google/gemini-3.8-flash", object: "model", owned_by: "vertex-google" },
        { id: "xai/grok-4.6", object: "model", owned_by: "vertex-xai" },
      ],
    };
    let chatCalls = 0;
    chatHandler = (_body, res) => {
      streamChunks(res, [
        { choices: [{ index: 0, delta: { reasoning_content: "Checking." } }] },
        { choices: [{ index: 0, delta: { content: "VERTEX_ADAPTER_OK" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 21, completion_tokens: 9 } },
      ]);
    };

    server = createServer(async (req, res) => {
      const path = req.url ?? "";
      const record = { method: req.method ?? "GET", path, authorization: req.headers.authorization, body: undefined as ChatBody | undefined };
      requests.push(record);

      if (path === "/healthz") {
        if (healthPathMode === "v1") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        res.writeHead(healthStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(healthBody));
        return;
      }
      if (path === "/v1/healthz") {
        res.writeHead(healthStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(healthBody));
        return;
      }
      if (path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(modelsBody));
        return;
      }
      if (path === "/v1/chat/completions") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        record.body = JSON.parse(raw) as ChatBody;
        chatCalls += 1;
        chatHandler(record.body, res, chatCalls);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fake proxy port");
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterEach(async () => {
    await Promise.all(instances.map((instance) => instance.dispose()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const createInstance = async (
    instanceId = `vertex-test-${Math.random().toString(36).slice(2, 8)}`,
    config: Record<string, unknown> = { baseUrl },
    environment: Record<string, string> = {},
  ) => {
    const instance = await VertexDriver.create({
      instanceId,
      displayName: "Vertex AI",
      enabled: true,
      config: VertexDriver.decodeConfig(config),
      environment,
    });
    instances.push(instance);
    return instance;
  };

  it("auto-probes the default loopback URL with zero config and placeholder bearer", async () => {
    vi.stubEnv("OMB_DISABLE_DEFAULT_VERTEX_PROBE", "");
    vi.stubEnv("OMB_TEST_SEALED_PATH", "");
    vi.stubEnv("OMB_ALLOW_DEFAULT_VERTEX_PROBE", "1");
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url === "http://127.0.0.1:18790/healthz") {
        return Response.json({ ok: true, project: "ministry-brands-394515" });
      }
      if (url === "http://127.0.0.1:18790/v1/models") {
        return Response.json({ object: "list", data: [{ id: "google/gemini-4-carbon", object: "model" }] });
      }
      return new Response("not found", { status: 404 });
    }));

    const instance = await createInstance("vertex-zero-cfg", {}, {});
    const snap = await instance.snapshot();
    expect(snap).toMatchObject({ state: "available", authenticated: true });
    expect(instance.models.default).toBe("google/gemini-4-carbon");
    expect(seen).toEqual(expect.arrayContaining([
      { url: "http://127.0.0.1:18790/v1/models", auth: "Bearer local-vertex-proxy" },
      { url: "http://127.0.0.1:18790/healthz", auth: "Bearer local-vertex-proxy" },
    ]));

    vi.stubEnv("OMB_ALLOW_DEFAULT_VERTEX_PROBE", "");
    vi.stubEnv("OMB_DATA_DIR", "/Users/person/.openmausbot");
    let directCalls = 0;
    const directProbe = await probeVertexHealth(VERTEX_DEFAULT_BASE_URL, {
      fetchImpl: async () => {
        directCalls++;
        return Response.json({ ok: true });
      },
    });
    expect(directProbe).toEqual({ ok: true });
    expect(directCalls).toBe(1);

    vi.stubEnv("OMB_CLOUD_ROLE", "home");
    const cloudProbe = await probeVertexHealth(VERTEX_DEFAULT_BASE_URL, {
      fetchImpl: async () => {
        directCalls++;
        return Response.json({ ok: true });
      },
    });
    expect(cloudProbe.ok).toBe(false);
    expect(directCalls).toBe(1);
  });

  it("reports healthy vs connection-refused vs /v1/healthz fallback states", async () => {
    const instance = await createInstance("vertex-health");
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });

    healthPathMode = "v1";
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });

    healthBody = { ok: false };
    expect(await instance.snapshot()).toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("unhealthy"),
    });

    const closedServer = createServer();
    await new Promise<void>((resolve) => closedServer.listen(0, "127.0.0.1", resolve));
    const closedPort = (closedServer.address() as { port: number }).port;
    await new Promise<void>((resolve) => closedServer.close(() => resolve()));

    const downHealth = await probeVertexHealth(`http://127.0.0.1:${closedPort}/v1`);
    expect(downHealth).toEqual({
      ok: false,
      reason: `The Vertex proxy isn't running on this machine (http://127.0.0.1:${closedPort}).`,
    });
  });

  it("persists the discovered catalog to providers/engine-models/<id>.json and updates on refreshModels", async () => {
    const id = "vertex-cache-check";
    const instance = await createInstance(id);
    expect(instance.modelsUnconfirmed).toBe(false);

    const cacheFile = startupModelCachePath(id)!;
    expect(existsSync(cacheFile)).toBe(true);
    const cached = readStartupModelCache(id);
    expect(cached?.options.map((o) => o.id)).toEqual([
      "google/gemini-4-carbon",
      "google/gemini-4-neon",
      "google/gemini-3.8-flash",
      "xai/grok-4.6",
    ]);
    expect(cached?.options.find((o) => o.id === "google/gemini-4-neon")?.variants?.map((v) => v.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);

    modelsBody = {
      object: "list",
      data: [
        { id: "google/gemini-4-carbon", object: "model" },
        { id: "xai/grok-4.7", object: "model" },
      ],
    };
    await instance.refreshModels?.();
    expect(instance.models.options.map((o) => o.id)).toEqual(["google/gemini-4-carbon", "xai/grok-4.7"]);
    expect(readStartupModelCache(id)?.options.map((o) => o.id)).toEqual(["google/gemini-4-carbon", "xai/grok-4.7"]);
  });

  it("streams chat completions with reasoning_effort, max_completion_tokens, and usage reporting", async () => {
    const instance = await createInstance("vertex-stream");
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-stream",
        text: "Ping",
        model: "google/gemini-4-neon",
        variant: "xhigh",
      });
      const completed = await recorder.until((event) => event.type === "turn.completed");
      expect(completed).toMatchObject({ ok: true, usage: { input: 21, output: 9 } });
      expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "reasoning_text" && e.delta === "Checking.")).toBe(true);
      expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "assistant_text" && e.delta === "VERTEX_ADAPTER_OK")).toBe(true);

      const chatReq = requests.find((r) => r.path === "/v1/chat/completions")!;
      expect(chatReq.authorization).toBe(`Bearer ${VERTEX_PLACEHOLDER_API_KEY}`);
      expect(chatReq.body).toMatchObject({
        model: "google/gemini-4-neon",
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 65_536,
        reasoning_effort: "xhigh",
      });
    } finally {
      recorder.stop();
    }
  });

  it("round-trips Gemini tool_calls[].extra_content.google.thought_signature verbatim on multi-round turns", async () => {
    const signature = "ErYBCrMBAdH+gemini4ThoughtSignatureBase64Payload==";
    chatHandler = (_body, res, attempt) => {
      if (attempt === 1) {
        streamChunks(res, [
          {
            choices: [
              {
                index: 0,
                delta: {
                  reasoning_content: "Need tool.",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_gemini_sig_1",
                      type: "function",
                      function: { name: "fixture_missing_tool", arguments: '{"query":"status"}' },
                      extra_content: { google: { thought_signature: signature } },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
        return;
      }
      streamChunks(res, [
        { choices: [{ index: 0, delta: { content: "Completed after tool replay." }, finish_reason: "stop" }] },
      ]);
    };

    const instance = await createInstance("vertex-sig");
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-sig",
        text: "Run tool",
        model: "google/gemini-4-carbon",
        variant: "medium",
        approvalMode: "full",
      });
      await recorder.until((event) => event.type === "turn.completed");
      const chatReqs = requests.filter((r) => r.path === "/v1/chat/completions");
      expect(chatReqs).toHaveLength(2);
      const replayedAssistant = chatReqs[1]!.body!.messages.find((m) => m.role === "assistant");
      expect(replayedAssistant).toBeDefined();
      expect(replayedAssistant?.tool_calls).toEqual([
        {
          id: "call_gemini_sig_1",
          type: "function",
          function: { name: "fixture_missing_tool", arguments: '{"query":"status"}' },
          extra_content: { google: { thought_signature: signature } },
        },
      ]);
    } finally {
      recorder.stop();
    }
  });

  it("handles 401 invalid credentials, 429 Retry-After backoff recovery, and 404 regional/missing publisher model", async () => {
    const observedDelays: number[] = [];
    const customFetch = createVertexFetch({
      retryScale: 0,
      onRetry: (_attempt, delayMs) => observedDelays.push(delayMs),
    });
    let calls429 = 0;
    const recovered = await customFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-4-carbon", messages: [], stream: false }),
    });
    await recovered.body?.cancel().catch(() => {});

    chatHandler = (_body, res) => {
      calls429 += 1;
      if (calls429 <= 2) {
        res.writeHead(429, {
          "content-type": "application/json",
          ...(calls429 === 2 ? { "retry-after": "7" } : {}),
        });
        res.end(JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }));
        return;
      }
      streamChunks(res, [{ choices: [{ index: 0, delta: { content: "Recovered!" }, finish_reason: "stop" }] }]);
    };

    const retryRes = await customFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-4-carbon", messages: [], stream: true }),
    });
    expect(retryRes.status).toBe(200);
    await retryRes.body?.cancel().catch(() => {});
    expect(observedDelays).toEqual([0, 7_000]);

    chatHandler = (_body, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          code: 404,
          message: "Publisher Model `projects/ministry-brands-394515/locations/us-central1/publishers/google/models/gemini-4-carbon` was not found.",
          status: "NOT_FOUND",
        },
      }));
    };
    const instance404 = await createInstance("vertex-404");
    const rec404 = recordEvents(instance404.adapter);
    try {
      await instance404.adapter.sendTurn({ threadId: "t-404", text: "Hi", model: "google/gemini-4-carbon" });
      const errEvent = await rec404.until((e) => e.type === "runtime.error");
      expect(errEvent.type === "runtime.error" ? errEvent.message : "").toContain("global endpoint");
      await rec404.until((e) => e.type === "turn.completed");
    } finally {
      rec404.stop();
    }

    chatHandler = (_body, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid authentication credentials", code: 401 } }));
    };
    const instance401 = await createInstance("vertex-401", { baseUrl, apiKey: "rejected-custom-vertex-token" });
    const rec401 = recordEvents(instance401.adapter);
    try {
      await instance401.adapter.sendTurn({ threadId: "t-401", text: "Hi", model: "google/gemini-4-carbon" });
      const errEvent = await rec401.until((e) => e.type === "runtime.error");
      expect(classifyError(new Error(errEvent.type === "runtime.error" ? errEvent.message : ""))).toEqual({
        transient: false,
        reason: "auth",
      });
      await rec401.until((e) => e.type === "turn.completed");
      expect(await instance401.snapshot()).toMatchObject({ state: "available", authenticated: false });
    } finally {
      rec401.stop();
    }

    let exhaustedCalls = 0;
    chatHandler = (_body, res) => {
      exhaustedCalls += 1;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: { message: "Quota temporarily saturated", code: 429 } }));
    };
    const instance429 = await createInstance("vertex-429-exhausted");
    const rec429 = recordEvents(instance429.adapter);
    try {
      await instance429.adapter.sendTurn({ threadId: "t-429", text: "Hi", model: "google/gemini-4-carbon" });
      const errEvent = await rec429.until((e) => e.type === "runtime.error");
      expect(exhaustedCalls).toBe(5);
      expect(classifyError(new Error(errEvent.type === "runtime.error" ? errEvent.message : ""))).toEqual({
        transient: true,
        reason: "rate_limited",
      });
      await rec429.until((e) => e.type === "turn.completed");
    } finally {
      rec429.stop();
    }

    chatHandler = (_body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: "google/gemini-3.8-flash",
        choices: [{ index: 0, message: { content: "Short title" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }));
    };
    let helperUsage: unknown;
    const generated = await instance404.generateText?.("Summarize", {
      model: "google/gemini-3.8-flash",
      onUsage: (u) => { helperUsage = u; },
    });
    expect(generated).toBe("Short title");
    expect(helperUsage).toMatchObject({ model: "google/gemini-3.8-flash", input: 10, output: 3 });
  });
});
