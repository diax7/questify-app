export type PostResult =
  | Readonly<{ ok: true; body: unknown }>
  | Readonly<{ ok: false; body: unknown }>;

/** Posts JSON to the API through the same-origin forwarder. A dropped connection comes back as not ok, no body. */
export async function postJson(path: string, payload: unknown): Promise<PostResult> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body: unknown = await response.json().catch(() => undefined);
    return { ok: response.ok, body };
  } catch {
    return { ok: false, body: undefined };
  }
}
