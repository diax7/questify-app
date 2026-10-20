export type PostResult =
  | Readonly<{ ok: true; body: unknown }>
  | Readonly<{ ok: false; body: unknown }>;

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
    return { ok: response.ok, body };
  } catch {
    return { ok: false, body: undefined };
  }
}
