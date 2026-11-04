// A small HTTP client for the load drivers: keep-alive connections, a hard timeout, and the time each answer took.
import { Agent, request } from "node:http";
import { randomUUID } from "node:crypto";

/** The app gives up on a call after 15 s, counted from the call (apps/app/src/api/client.ts); so does the driver. */
const TIMEOUT_MS = 15_000;

/**
 * A client for one API base URL with at most `sockets` open connections; requests past that wait in the agent's
 * queue, and that wait is part of their measured latency and of their 15 s.
 *
 * @param {string} baseUrl
 * @param {number} sockets
 */
export function createClient(baseUrl, sockets) {
  const agent = new Agent({ keepAlive: true, maxSockets: sockets });
  const base = new URL(baseUrl);
  /**
   * @param {string} method
   * @param {string} path
   * @param {Readonly<Record<string, string>>} headers
   * @param {unknown} [body]
   * @returns {Promise<{ status: string; body: string }>} status is the HTTP code, `timeout` or `network_<code>`
   */
  const send = (method, path, headers, body) =>
    new Promise((resolve) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          agent,
          host: base.hostname,
          port: base.port,
          method,
          path,
          headers: {
            ...headers,
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            clearTimeout(deadline);
            resolve({ status: String(res.statusCode), body: Buffer.concat(chunks).toString() });
          });
        },
      );
      const deadline = setTimeout(() => req.destroy(new Error("timeout")), TIMEOUT_MS);
      req.on("error", (error) => {
        clearTimeout(deadline);
        const status =
          error.message === "timeout" ? "timeout" : `network_${error.code ?? "unknown"}`;
        resolve({ status, body: "" });
      });
      req.end(payload);
    });
  return { send, close: () => agent.destroy() };
}

/**
 * The headers of a player's completion: the bearer token and a fresh idempotency key, as the app sends them.
 *
 * @param {string} token
 */
export function playerHeaders(token) {
  return { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() };
}
