// Small HTTP helpers of the monitoring validation.
import { connect } from "node:net";

export function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

export const basic = (user, password) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

/** One request; the body is read in full. `json()` parses it. */
export async function request(url, { method = "GET", headers = {}, body } = {}) {
  const init = { method, headers, signal: AbortSignal.timeout(20_000) };
  if (body !== undefined) init.body = body;
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) };
}

export const postJson = (url, payload, headers = {}) =>
  request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

/**
 * The status line of an OTLP request sent with exactly this `Authorization` line (empty for none). Raw sockets, because
 * `fetch` rewrites header values and the point is to send an odd one.
 */
export function rawStatus(port, authorizationLine) {
  return new Promise((resolve, reject) => {
    const body = '{"resourceMetrics":[]}';
    const lines = [
      "POST /v1/metrics HTTP/1.1",
      "Host: collector",
      "Content-Type: application/json",
      `Content-Length: ${body.length}`,
      "Connection: close",
    ];
    if (authorizationLine !== "") lines.push(authorizationLine);
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`),
    );
    let received = "";
    socket.on("data", (chunk) => (received += chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1])));
  });
}
