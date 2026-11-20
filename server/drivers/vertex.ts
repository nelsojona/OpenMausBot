import { z } from "zod";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { openStartupModelCatalog, unconfirmedModelCatalog, writeStartupModelCache } from "../startup-model-catalog.ts";
import { advertisedContextWindow } from "./openai-compat.ts";
import { createOpenAIChatRuntime, type OpenAIChatMessage } from "./openai-chat.ts";
import { interruptibleDelay } from "./retry.ts";

export const VERTEX_DEFAULT_BASE_URL = "http://127.0.0.1:18790/v1";
/** Non-secret loopback bearer convention; GCP credentials stay inside the vertex-grok-proxy LaunchAgent. */
export const VERTEX_PLACEHOLDER_API_KEY = "local-vertex-proxy";
export const VERTEX_HEALTH_TIMEOUT_MS = 2_500;
export const VERTEX_RETRY_SCHEDULE_MS = [0, 5_000, 15_000, 30_000] as const;
export const VERTEX_RETRY_CAP_MS = 60_000;

export type VertexEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface VertexModelSpec {
  readonly label: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly efforts: readonly VertexEffort[];
}

const EFFORT_LABELS: Readonly<Record<VertexEffort, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

const GEMINI_STANDARD_EFFORTS: readonly VertexEffort[] = ["low", "medium", "high"];
const GEMINI_DEEP_EFFORTS: readonly VertexEffort[] = ["low", "medium", "high", "xhigh"];
const GROK_VERTEX_EFFORTS: readonly VertexEffort[] = ["minimal", "low", "medium", "high", "max"];

// Vertex AI on ministry-brands-394515 serves these models on the global endpoint only.
// Endpoint-enforced effort enums: Grok rejects `xhigh` with HTTP 400; Gemini rejects `minimal` and `max`;
// Gemini 4 Neon and Hydrogen accept `xhigh`, while Gemini 3.8 Flash accepts `low`, `medium`, `high`.
// Gemini 4 defaults to 65536 max_completion_tokens (1M requires opt-in long decode).
export const VERTEX_KNOWN_MODELS: ReadonlyMap<string, VertexModelSpec> = new Map<string, VertexModelSpec>([
  ["google/gemini-4-carbon", { label: "Gemini 4 Carbon (Vertex)", contextWindow: 1_048_576, maxTokens: 65_536, efforts: GEMINI_STANDARD_EFFORTS }],
  ["google/gemini-4-argon", { label: "Gemini 4 Argon (Vertex)", contextWindow: 1_048_576, maxTokens: 65_536, efforts: GEMINI_STANDARD_EFFORTS }],
  ["google/gemini-4-hydrogen", { label: "Gemini 4 Hydrogen (Vertex)", contextWindow: 1_048_576, maxTokens: 65_536, efforts: GEMINI_DEEP_EFFORTS }],
  ["google/gemini-4-neon", { label: "Gemini 4 Neon (Vertex)", contextWindow: 1_048_576, maxTokens: 65_536, efforts: GEMINI_DEEP_EFFORTS }],
  ["google/gemini-3.8-flash", { label: "Gemini 3.8 Flash (Vertex)", contextWindow: 1_048_576, maxTokens: 65_536, efforts: GEMINI_STANDARD_EFFORTS }],
  ["xai/grok-4.6", { label: "Grok 4.6 (Vertex GCP)", contextWindow: 500_000, maxTokens: 128_000, efforts: GROK_VERTEX_EFFORTS }],
  ["xai/grok-4.7", { label: "Grok 4.7 (Vertex GCP)", contextWindow: 500_000, maxTokens: 128_000, efforts: GROK_VERTEX_EFFORTS }],
  ["grok-4.6", { label: "grok-4.6 (legacy id)", contextWindow: 500_000, maxTokens: 128_000, efforts: GROK_VERTEX_EFFORTS }],
  ["grok-4.5", { label: "grok-4.5 (legacy id)", contextWindow: 500_000, maxTokens: 128_000, efforts: GROK_VERTEX_EFFORTS }],
]);

const PREFERRED_DEFAULT_MODEL = "google/gemini-4-carbon";
const NO_MODELS: ModelCatalog = { default: "", options: [] };

export interface VertexConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  tools?: boolean;
}

const rawConfigSchema = z.object({
  baseUrl: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  tools: z.boolean().optional(),
});

function isLoopbackHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

export function vertexProxyOrigin(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function splitVertexModelId(id: string): { publisher?: string; name: string } {
  const trimmed = id.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return { name: trimmed };
  return { publisher: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
}

function decodeConfig(raw: unknown): VertexConfig {
  const parsed = rawConfigSchema.parse(raw ?? {});
  const baseUrl = (parsed.baseUrl ?? parsed.url ?? VERTEX_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopbackHost(baseUrl))) {
    throw new Error("Vertex AI requires a loopback HTTP proxy or HTTPS endpoint.");
  }
  return {
    baseUrl,
    ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
  };
}

export function vertexModelOption(id: string, reportedWindow?: number): ModelCatalog["options"][number] {
  const known = VERTEX_KNOWN_MODELS.get(id);
  if (known) {
    return {
      id,
      label: known.label,
      contextWindow: known.contextWindow,
      variants: known.efforts.map((effort) => ({ id: effort, label: EFFORT_LABELS[effort] })),
    };
  }
  return {
    id,
    label: id,
    ...(reportedWindow ? { contextWindow: reportedWindow } : {}),
  };
}

const modelRowSchema = z.object({ id: z.string().trim().min(1) }).passthrough();

export function vertexCatalogFromModels(rows: readonly unknown[], preferredModel?: string): ModelCatalog {
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const parsed = modelRowSchema.safeParse(row);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const { id } = parsed.data;
    seen.add(id);
    options.push(vertexModelOption(id, advertisedContextWindow(parsed.data)));
  }
  if (preferredModel && !seen.has(preferredModel)) {
    options.unshift(vertexModelOption(preferredModel));
  }
  if (!options.length) return NO_MODELS;
  const preferred = preferredModel
    ?? (options.some((option) => option.id === PREFERRED_DEFAULT_MODEL) ? PREFERRED_DEFAULT_MODEL : options[0]!.id);
  return {
    default: options.some((option) => option.id === preferred) ? preferred : options[0]!.id,
    options,
  };
}

export function vertexReasoningEffort(modelId: string, variant?: string): VertexEffort | undefined {
  if (!variant) return undefined;
  const known = VERTEX_KNOWN_MODELS.get(modelId);
  if (!known) return undefined;
  return known.efforts.includes(variant as VertexEffort) ? (variant as VertexEffort) : undefined;
}

export function vertexMaxCompletionTokens(modelId: string): number | undefined {
  return VERTEX_KNOWN_MODELS.get(modelId)?.maxTokens;
}

export function vertexRequestBody(
  model: string,
  messages: OpenAIChatMessage[],
  stream: boolean,
  variant?: string,
): Record<string, unknown> {
  const effort = vertexReasoningEffort(model, variant);
  const maxTokens = vertexMaxCompletionTokens(model);
  return {
    model,
    messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(maxTokens !== undefined ? { max_completion_tokens: maxTokens } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

export function vertexRetryAfterMs(header: string | null | undefined, now = Date.now()): number | null {
  const trimmed = header?.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : null;
  }
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function vertexRetryDelayMs(attempt: number, retryAfterHeader?: string | null, now = Date.now()): number {
  const headerMs = vertexRetryAfterMs(retryAfterHeader, now);
  if (headerMs !== null) return Math.min(VERTEX_RETRY_CAP_MS, headerMs);
  const index = Math.min(Math.max(attempt, 0), VERTEX_RETRY_SCHEDULE_MS.length - 1);
  return Math.min(VERTEX_RETRY_CAP_MS, VERTEX_RETRY_SCHEDULE_MS[index]!);
}

const PUBLISHER_MODEL_NOT_FOUND = /publisher[- _]model|was not found|model[^.\n]*not[ _-]found|\bnot_found\b/i;

export function vertexPlainRefusal(status: number, body: string): string | undefined {
  if (status === 404 && (!body.trim() || PUBLISHER_MODEL_NOT_FOUND.test(body))) {
    return "Vertex AI model not found (HTTP 404): this model is unavailable, or the proxy was pointed at a regional endpoint instead of Vertex AI's global endpoint.";
  }
  // GCP Vertex 429 RESOURCE_EXHAUSTED bodies include "(e.g. check quota)", which classifyError would otherwise treat as terminal 402 quota.
  if (status === 429) {
    return "Vertex AI HTTP 429: rate limit reached (resource exhausted). Wait a moment and try again.";
  }
  return undefined;
}

function connectionRefused(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown; errors?: unknown } } | undefined)?.cause;
  if (cause?.code === "ECONNREFUSED") return true;
  if (Array.isArray(cause?.errors) && cause.errors.length > 0) {
    return cause.errors.every((entry) => (entry as { code?: unknown }).code === "ECONNREFUSED");
  }
  return /\beconnrefused\b|\bconnection refused\b/i.test(error instanceof Error ? error.message : String(error));
}

const timedOut = (error: unknown) =>
  (error as { name?: unknown } | undefined)?.name === "TimeoutError"
  || /\btimed? out\b/i.test(error instanceof Error ? error.message : String(error));

function defaultProbeDisabled(baseUrl: string): boolean {
  if (baseUrl !== VERTEX_DEFAULT_BASE_URL) return false;
  if (process.env.OMB_VERTEX_URL?.trim()) return false;
  return process.env.OMB_DISABLE_DEFAULT_VERTEX_PROBE === "1" || process.env.OMB_TEST_SEALED_PATH === "1";
}

export async function probeVertexHealth(
  baseUrl: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; apiKey?: string } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const origin = vertexProxyOrigin(baseUrl);
  const notRunning = `The Vertex proxy isn't running on this machine (${origin}).`;
  if (defaultProbeDisabled(baseUrl)) return { ok: false, reason: notRunning };
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? VERTEX_HEALTH_TIMEOUT_MS;
  const headers = options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : undefined;
  const ask = (url: string) =>
    fetchImpl(url, { ...(headers ? { headers } : {}), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  try {
    let response = await ask(`${origin}/healthz`);
    if (response.status === 404 && origin !== baseUrl) {
      await response.body?.cancel().catch(() => {});
      response = await ask(`${baseUrl}/healthz`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: `The Vertex proxy at ${origin} answered HTTP ${response.status} on /healthz.` };
    }
    const text = await response.text();
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text) as { ok?: unknown };
        if (parsed && typeof parsed === "object" && parsed.ok === false) {
          return { ok: false, reason: `The Vertex proxy at ${origin} reported unhealthy status.` };
        }
      } catch {
        // Plain-text 200 health responses still count as healthy.
      }
    }
    return { ok: true };
  } catch (error) {
    if (connectionRefused(error)) return { ok: false, reason: notRunning };
    if (timedOut(error)) return { ok: false, reason: `Timed out waiting for the Vertex proxy at ${origin}.` };
    return { ok: false, reason: notRunning };
  }
}

export function createVertexFetch(options: {
  fetchImpl?: typeof fetch;
  retryScale?: number;
  now?: () => number;
  onRetry?: (attempt: number, delayMs: number) => void;
} = {}): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  return async (input, init) => {
    const scaleRaw = options.retryScale ?? Number(process.env.FAKE_VERTEX_RETRY_SCALE ?? "1");
    const retryScale = Number.isFinite(scaleRaw) && scaleRaw >= 0 ? scaleRaw : 1;
    const signal = init?.signal ?? undefined;
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(input, init);
      if (response.status !== 429 || attempt >= VERTEX_RETRY_SCHEDULE_MS.length || signal?.aborted) {
        return response;
      }
      const delayMs = vertexRetryDelayMs(attempt, response.headers.get("retry-after"), now());
      await response.body?.cancel().catch(() => {});
      options.onRetry?.(attempt + 1, delayMs);
      const scaledMs = Math.round(delayMs * retryScale);
      if (scaledMs > 0) {
        const outcome = await interruptibleDelay(scaledMs, signal).promise;
        if (outcome === "cancelled") signal?.throwIfAborted();
      }
      signal?.throwIfAborted();
    }
  };
}

export const VertexDriver: ProviderDriver<VertexConfig> = {
  driverKind: "vertex",
  metadata: { displayName: "Vertex AI", supportsMultipleInstances: true, access: "api" },
  models: NO_MODELS,
  install: {
    settings: "connections",
    signInCommand: "Start vertex-grok-proxy on http://127.0.0.1:18790, or set a custom proxy address in Settings → AI → Providers.",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  async create(input) {
    const { config } = input;
    // A custom non-loopback host must bring its own credential; the workspace key never crosses to another host.
    const apiKey = (
      config.apiKey
      ?? input.environment.VERTEX_API_KEY
      ?? (config.baseUrl === VERTEX_DEFAULT_BASE_URL ? process.env.VERTEX_API_KEY : undefined)
      ?? (isLoopbackHost(config.baseUrl) ? VERTEX_PLACEHOLDER_API_KEY : "")
    ).trim();

    let catalog: ModelCatalog = config.model
      ? { default: config.model, options: [vertexModelOption(config.model)] }
      : NO_MODELS;
    let readFromProxy = false;
    let inFlightRefresh: Promise<void> | null = null;

    const performRefresh = async () => {
      if (!apiKey || defaultProbeDisabled(config.baseUrl)) {
        unconfirmedModelCatalog(catalog);
        return;
      }
      try {
        const response = await fetch(`${config.baseUrl}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          unconfirmedModelCatalog(catalog);
          return;
        }
        const payload = z.object({ data: z.array(z.unknown()) }).parse(await response.json());
        const next = vertexCatalogFromModels(payload.data, config.model);
        if (next.options.length) {
          catalog = next;
          readFromProxy = true;
          try { writeStartupModelCache(input.instanceId, catalog); } catch {}
        } else {
          unconfirmedModelCatalog(catalog);
        }
      } catch {
        unconfirmedModelCatalog(catalog);
      }
    };

    const refreshModels = () => {
      if (inFlightRefresh) return inFlightRefresh;
      const run = performRefresh().finally(() => {
        if (inFlightRefresh === run) inFlightRefresh = null;
      });
      inFlightRefresh = run;
      return run;
    };

    const startupRefresh = openStartupModelCatalog({
      instanceId: input.instanceId,
      use: (saved) => {
        catalog = vertexCatalogFromModels(
          saved.options.map((option) => ({ id: option.id, contextWindow: option.contextWindow })),
          config.model,
        );
      },
      current: () => catalog,
      refresh: refreshModels,
    });
    if (startupRefresh instanceof Promise) {
      await Promise.race([
        startupRefresh,
        new Promise<null>((resolve) => { setTimeout(() => resolve(null), VERTEX_HEALTH_TIMEOUT_MS).unref(); }),
      ]);
    }

    const runtime = createOpenAIChatRuntime({
      input,
      driverKind: "vertex",
      apiKey,
      apiUrl: config.baseUrl,
      fetch: createVertexFetch(),
      tools: config.tools,
      models: () => catalog,
      refreshModels,
      modelVariants: true,
      reasoning: true,
      reasoningOffBody: () => ({}),
      selectedReasoning: (model, variant) => Boolean(vertexReasoningEffort(model, variant)),
      computerUse: true,
      requestBody: (model, messages, stream, variant) => vertexRequestBody(model, messages, stream, variant),
      httpErrorLabel: "Vertex AI",
      plainRefusal: vertexPlainRefusal,
      missingKeyError: "Save a Vertex proxy token in Settings → AI → Providers, or set VERTEX_API_KEY.",
      unavailableReason: "No Vertex proxy token — open Settings → AI → Providers.",
      serverUnavailable: async () => {
        const health = await probeVertexHealth(config.baseUrl, { apiKey });
        if (!health.ok) return { reason: health.reason };
        if (!catalog.options.length) await refreshModels();
        if (!catalog.options.length) {
          return { reason: `The Vertex proxy at ${vertexProxyOrigin(config.baseUrl)} listed no models.` };
        }
        return null;
      },
      timeoutMs: 180_000,
      billing: "metered",
      includeUsageInCompleted: true,
      nativeLog: {
        source: "vertex.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
      },
    });

    return {
      ...runtime,
      get models() {
        return catalog;
      },
      get modelsUnconfirmed() {
        return !readFromProxy;
      },
    };
  },
};
