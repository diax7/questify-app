import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPLETION_ROUTES } from "#src/telemetry/http";
import { buildLoggedApp, recordTelemetry, type Recording } from "#test/support/telemetry";

let recording: Recording;
let app: FastifyInstance;
let lines: string[];

beforeEach(() => {
  recording = recordTelemetry();
  ({ app, lines } = buildLoggedApp());
  app.get("/probe/:thing", { config: { access: "public" } }, async (request) => {
    request.log.info({ event: "probe.logged", note: "kept" });
    request.log.error({ event: "probe.failed" });
    request.log.info("a line with no event");
    return { span: trace.getActiveSpan()?.spanContext().traceId ?? null };
  });
  app.get("/probe-boom", { config: { access: "public" } }, async () => {
    throw new Error("boom");
  });
});

afterEach(async () => {
  await app.close();
  await recording.shutdown();
});

const logged = (): Array<Record<string, unknown>> =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("request spans", () => {
  it("records one server span named by the route pattern, never the URL", async () => {
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/probe/secret-value?x=1" });
    expect(response.statusCode).toBe(200);
    const [span] = recording.spans().filter((item) => item.name.startsWith("GET /probe"));
    expect(span?.name).toBe("GET /probe/:thing");
    expect(span?.kind).toBe(SpanKind.SERVER);
    expect(span?.attributes).toEqual({
      "http.request.method": "GET",
      "http.route": "/probe/:thing",
      "http.response.status_code": 200,
    });
  });

  it("calls a path no route answers `unmatched`, so scanners cannot make labels", async () => {
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/wp-login.php/guess-1234" });
    expect(response.statusCode).toBe(404);
    const [span] = recording.spans();
    expect(span?.attributes["http.route"]).toBe("unmatched");
    expect(span?.attributes["http.response.status_code"]).toBe(404);
  });

  it("marks a 5xx answer as an error and a 4xx answer as not one", async () => {
    await app.ready();
    await app.inject({ method: "GET", url: "/probe-boom" });
    await app.inject({ method: "GET", url: "/nowhere" });
    const byRoute = new Map(recording.spans().map((span) => [span.attributes["http.route"], span]));
    expect(byRoute.get("/probe-boom")?.status.code).toBe(SpanStatusCode.ERROR);
    expect(byRoute.get("unmatched")?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("does not continue a trace a client sends", async () => {
    await app.ready();
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { traceparent: `00-${traceId}-b7ad6b7169203331-01` },
    });
    const [span] = recording.spans();
    expect(span?.spanContext().traceId).not.toBe(traceId);
    expect(span?.parentSpanContext).toBeUndefined();
  });
});

describe("request metrics", () => {
  it("measures every request by method, route, status and route class", async () => {
    await app.ready();
    await app.inject({ method: "GET", url: "/healthz" });
    await app.inject({ method: "GET", url: "/healthz" });
    const points = (await recording.metrics()).get("http.server.request.duration") ?? [];
    expect(points).toHaveLength(1);
    expect(points[0]?.attributes).toEqual({
      "http.request.method": "GET",
      "http.route": "/healthz",
      "http.response.status_code": 200,
      "questify.route_class": "other",
    });
    expect(points[0]?.value).toMatchObject({ count: 2 });
  });

  it("puts the scan routes in the completion class", async () => {
    await app.ready();
    await app.inject({
      method: "POST",
      url: "/v1/quests/00000000-0000-4000-8000-000000000001/complete",
    });
    const points = (await recording.metrics()).get("http.server.request.duration") ?? [];
    expect(points[0]?.attributes).toMatchObject({
      "http.route": "/v1/quests/:questId/complete",
      "questify.route_class": "completion",
    });
  });

  it("names only routes the server has: every completion route exists", async () => {
    await app.ready();
    const routes = new Set(app.routeInventory.map((route) => `${route.method} ${route.url}`));
    for (const route of COMPLETION_ROUTES) {
      expect(routes, route).toContain(route);
    }
  });

  it("gives every route of the server a pattern a label may carry", async () => {
    await app.ready();
    const { safeAttributes } = await import("#src/telemetry/attributes");
    for (const route of app.routeInventory) {
      expect(safeAttributes({ "http.route": route.url }), route.url).toEqual({
        "http.route": route.url,
      });
    }
  });
});

describe("logs", () => {
  it("carry the trace and span ids of the request they were written in", async () => {
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/probe/x" });
    const [span] = recording.spans().filter((item) => item.name === "GET /probe/:thing");
    const inRequest = logged().filter((line) => line["event"] === "probe.logged");
    expect(inRequest).toHaveLength(1);
    expect(inRequest[0]?.["trace_id"]).toBe(span?.spanContext().traceId);
    expect(inRequest[0]?.["span_id"]).toBe(span?.spanContext().spanId);
    expect(response.json()).toEqual({ span: span?.spanContext().traceId });
  });

  it("carry no ids when no span is active", async () => {
    await app.ready();
    app.log.info({ event: "probe.outside" });
    const line = logged().find((item) => item["event"] === "probe.outside");
    expect(line).toBeDefined();
    expect(line).not.toHaveProperty("trace_id");
  });

  it("are counted by event and level, and only when they name an event", async () => {
    await app.ready();
    await app.inject({ method: "GET", url: "/probe/x" });
    await app.inject({ method: "GET", url: "/probe/y" });
    const points = (await recording.metrics()).get("questify.log.events") ?? [];
    const counts = Object.fromEntries(
      points.map((point) => [
        `${String(point.attributes["questify.event"])}:${String(point.attributes["questify.log.level"])}`,
        point.value,
      ]),
    );
    expect(counts["probe.logged:info"]).toBe(2);
    expect(counts["probe.failed:error"]).toBe(2);
    expect(Object.keys(counts).every((key) => key.includes("."))).toBe(true);
  });

  it("are still written when telemetry is off", async () => {
    await recording.shutdown();
    await app.ready();
    await app.inject({ method: "GET", url: "/probe/x" });
    const line = logged().find((item) => item["event"] === "probe.logged");
    expect(line?.["note"]).toBe("kept");
    expect(line).not.toHaveProperty("trace_id");
  });
});
