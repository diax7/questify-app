import { webConfig } from "#src/lib/config.ts";
import { forward } from "#src/lib/forward.ts";

export const dynamic = "force-dynamic";

/** Every `/v1` call from the browser goes to the API through here (T-011 plan, same-origin forwarder). */
function handle(request: Request): Promise<Response> {
  return forward(request, {
    apiOrigin: webConfig().apiOrigin,
    timeoutMs: 15_000,
    maxBodyBytes: 1_048_576,
    // One JSON line on the server log (stderr), like the API's own log lines.
    log: (fields) => void process.stderr.write(`${JSON.stringify(fields)}\n`),
  });
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
