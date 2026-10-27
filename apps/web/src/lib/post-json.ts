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

/**
 * Calls the API through the same-origin forwarder with any method. A dropped connection comes back as not ok, no body;
 * an empty answer (204) as ok with no body.
 */
export async function requestJson(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<PostResult> {
  try {
    const response = await fetch(path, {
      method,
      headers: payload === undefined ? headers : { "content-type": "application/json", ...headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    return { ok: response.ok, body, status: response.status };
  } catch {
    return { ok: false, body: undefined, status: 0 };
  }
}
