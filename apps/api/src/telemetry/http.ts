import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { safeAttributes, type RouteClass } from "#src/telemetry/attributes";
import { instruments, SCOPE } from "#src/telemetry/instruments";

/**
 * The routes that confirm a scan (ADR-074: 95% confirmed within 1 second): the quest scan or typed code, an NFC tap, an
 * operator's scan of a player's code and a kiosk scan. `telemetry.test.ts` checks each is a route of the server.
 */
export const COMPLETION_ROUTES: ReadonlySet<string> = new Set([
  "POST /v1/quests/:questId/complete",
  "POST /v1/taps",
  "POST /v1/operator/scan",
  "POST /v1/device/kiosk-scans",
]);

const UNMATCHED = "unmatched";

/** The registered pattern of the route that answers, or `unmatched`: never the URL a caller sent. */
function routeOf(request: FastifyRequest): string {
  return request.is404 ? UNMATCHED : (request.routeOptions.url ?? UNMATCHED);
}

const routeClassOf = (method: string, route: string): RouteClass =>
  COMPLETION_ROUTES.has(`${method} ${route}`) ? "completion" : "other";

/**
 * One server span and one duration sample for every request, labelled by method, route pattern, status and route
 * class. Register it first, so the other hooks and the handler run inside the span (logs then carry its ids). A request
 * that carries trace headers is not continued: a client does not choose our trace ids (ADR-601).
 */
export function registerHttpTelemetry(app: FastifyInstance): void {
  const spans = new WeakMap<FastifyRequest, Span>();

  app.addHook("onRequest", (request, _reply, done) => {
    const route = routeOf(request);
    const span = trace.getTracer(SCOPE).startSpan(`${request.method} ${route}`, {
      kind: SpanKind.SERVER,
      root: true,
      attributes: safeAttributes({ "http.request.method": request.method, "http.route": route }),
    });
    spans.set(request, span);
    context.with(trace.setSpan(ROOT_CONTEXT, span), done);
  });

  app.addHook("onResponse", (request, reply, done) => {
    const route = routeOf(request);
    const status = reply.statusCode;
    const span = spans.get(request);
    if (span !== undefined) {
      span.setAttributes(safeAttributes({ "http.response.status_code": status }));
      if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    }
    instruments().httpDuration.record(
      reply.elapsedTime / 1000,
      safeAttributes({
        "http.request.method": request.method,
        "http.route": route,
        "http.response.status_code": status,
        "questify.route_class": routeClassOf(request.method, route),
      }),
    );
    done();
  });
}
