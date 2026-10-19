export interface HttpRequestInit {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Minimal fetch signature. In the app this is backed by the Iwara Electron
 * session (Chromium network stack, shared cookies and Cloudflare clearance);
 * in tests it is backed by Node's fetch or a stub.
 */
export type HttpFetch = (url: string, init?: HttpRequestInit) => Promise<Response>;

export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

/** Case-insensitive header merge; later sources win. */
export function mergeHeaders(...sources: Array<Record<string, string> | undefined>): Record<string, string> {
  const merged = new Map<string, [string, string]>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      merged.set(key.toLowerCase(), [key, value]);
    }
  }
  return Object.fromEntries(merged.values());
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Releases the connection of a response whose body we don't need. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed or closed.
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
