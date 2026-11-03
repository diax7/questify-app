// Small HTTP helpers of the monitoring validation.

export function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

export const basic = (user, password) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

/** One request; redirects are not followed, the body is read in full. `json()` parses it. */
export async function request(url, { method = "GET", headers = {}, body } = {}) {
  const init = { method, headers, redirect: "manual", signal: AbortSignal.timeout(20_000) };
  if (body !== undefined) init.body = body;
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get("location") ?? "",
    text,
    json: () => JSON.parse(text),
  };
}

export const postJson = (url, payload, headers = {}) =>
  request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
