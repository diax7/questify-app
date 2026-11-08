/** `status` is the HTTP status, 0 for a dropped connection; it is absent only on results built by hand in tests. */
export type PostResult =
  | Readonly<{ ok: true; body: unknown; status?: number }>
  | Readonly<{ ok: false; body: unknown; status?: number }>;

/**
 * Whether a failed call may be retried as the same request (a dropped connection or a server fault, where the first
 * try may have been applied): its Idempotency-Key is kept. Any other answer, a refusal included, is final, so a
 * retry after it is a new request with a new key.
 */
export function isTransientFailure(result: PostResult): boolean {
  return !result.ok && (result.status === undefined || result.status === 0 || result.status >= 500);
}

/** Posts JSON to the API through the same-origin forwarder. A dropped connection comes back as not ok, no body. */
export function postJson(path: string, payload: unknown): Promise<PostResult> {
  return requestJson("POST", path, payload);
}

/** Every outside call has a timeout (rules.md): a call that is not answered in this long reads as a dropped connection. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** An export file is written while its rows are read; the forwarder allows it 180 s, so the browser waits a little more. */
export const EXPORT_REQUEST_TIMEOUT_MS = 200_000;
/** A change-set apply claims its set for 5 minutes in the API and the forwarder allows it 300 s; the browser waits longer. */
export const APPLY_REQUEST_TIMEOUT_MS = 330_000;

export type RequestOptions = Readonly<{ timeoutMs?: number }>;

/**
 * Calls the API through the same-origin forwarder with any method. A dropped connection, or no answer within
 * `options.timeoutMs` (30 s unless the call says more), comes back as not ok, status 0, no body; an empty answer (204)
 * as ok with no body.
 */
export async function requestJson(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
  headers: Readonly<Record<string, string>> = {},
  options: RequestOptions = {},
): Promise<PostResult> {
  // A timer of our own over the headers and the body: a stalled body must not hold the screen either.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(path, {
      method,
      headers: payload === undefined ? headers : { "content-type": "application/json", ...headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (controller.signal.aborted) {
      return { ok: false, body: undefined, status: 0 };
    }
    return { ok: response.ok, body, status: response.status };
  } catch {
    return { ok: false, body: undefined, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}
