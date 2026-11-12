import { webConfig } from "#src/lib/config.ts";
import { forward } from "#src/lib/forward.ts";
import { forwardBodyBytes, forwardTimeoutMs } from "#src/lib/forward-timeout.ts";

export const dynamic = "force-dynamic";

/**
 * Every `/v1` call from the browser goes to the API through here (T-011 plan, same-origin forwarder). Every method is
 * exported, OPTIONS included, and the route is an optional catch-all so a bare `/v1` reaches it too: Next answers
 * neither on its own, and its answers carry none of the API's security headers.
 */
function handle(request: Request): Promise<Response> {
  const config = webConfig();
  const { pathname } = new URL(request.url);
  return forward(request, {
    apiOrigin: config.apiOrigin,
    webOrigin: config.webOrigin,
    playerSession: config.playerWebSession,
    timeoutMs: forwardTimeoutMs(pathname),
    maxBodyBytes: forwardBodyBytes(pathname),
    // One JSON line on the server log (stderr), like the API's own log lines.
    log: (fields) => void process.stderr.write(`${JSON.stringify(fields)}\n`),
  });
}

export {
  handle as DELETE,
  handle as GET,
  handle as OPTIONS,
  handle as PATCH,
  handle as POST,
  handle as PUT,
};
