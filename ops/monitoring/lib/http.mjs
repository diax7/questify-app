// Small HTTP helpers of the monitoring validation.
import { request as httpRequest } from "node:http";

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

/**
 * One GET with the path written exactly as given: `fetch` collapses `.` and `..` segments before it sends, so a request
 * with them needs `node:http`. Resolves to `{ status }`.
 */
export const requestRawPath = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers, timeout: 20_000 },
      (response) => {
        response.resume();
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error(`GET ${path} timed out.`)));
    outgoing.on("error", reject);
    outgoing.end();
  });

export const postJson = (url, payload, headers = {}) =>
  request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
