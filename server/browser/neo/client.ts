const JSON_CAP_BYTES = 512 * 1024;
const BINARY_CAP_BYTES = 36 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 28_000;

export interface NeoProxyCallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function readBoundedBytes(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error("The BrowserOS neo proxy response exceeded the size limit.");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function forwardNeoHttpProxy(
  endpoint: string,
  token: string,
  session: string,
  command: Record<string, unknown>,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<NeoProxyCallResult> {
  const cap = command.command === "pdf" || command.command === "screenshot" ? BINARY_CAP_BYTES : JSON_CAP_BYTES;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-omb-browser-session": session,
      },
      body: JSON.stringify(command),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      status: 502,
      body: {
        ok: false,
        ...(command.command === "act" ? { completed: 0, uncertain: true } : {}),
        error: timedOut
          ? "The BrowserOS neo proxy did not answer in time."
          : `The BrowserOS neo proxy could not be reached: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
      },
    };
  }
  try {
    const raw = await readBoundedBytes(res, cap);
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: 502, body: { ok: false, error: "The BrowserOS neo proxy returned invalid JSON." } };
    }
    return { status: res.status, body: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      status: 502,
      body: {
        ok: false,
        ...(command.command === "act" ? { completed: 0, uncertain: true } : {}),
        error: error instanceof Error ? error.message : "The BrowserOS neo proxy response could not be read.",
      },
    };
  }
}

export async function checkNeoProxyHealth(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const healthUrl = new URL("/healthz", endpoint).toString();
    const res = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(3_000), redirect: "error" });
    if (!res.ok) return false;
    const json = (await res.json()) as { ok?: boolean; browser?: string };
    return json.ok === true && json.browser === "browseros-neo";
  } catch {
    return false;
  }
}
