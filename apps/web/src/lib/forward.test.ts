import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { forward, type ForwardOptions } from "#src/lib/forward.ts";
import { startUpstream, type Upstream } from "#src/lib/upstream.test-support.ts";

const WEB = "https://app.questify.test";

describe("forward (same-origin /v1 forwarder)", () => {
  let api: Upstream;
  let logged: Readonly<Record<string, string>>[] = [];
  const options = (extra: Partial<ForwardOptions> = {}): ForwardOptions => ({
    apiOrigin: api.origin,
    timeoutMs: 2_000,
    maxBodyBytes: 1_024,
    log: (fields) => logged.push(fields),
    ...extra,
  });

  beforeAll(async () => {
    api = await startUpstream();
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(() => {
    api.seen.length = 0;
    logged = [];
    api.answer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
  });

  it("keeps the method, path, query and body", async () => {
    const response = await forward(
      new Request(`${WEB}/v1/staff/auth/password?x=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"email":"a@b.sa"}',
      }),
      options(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(api.seen[0]).toMatchObject({
      method: "POST",
      url: "/v1/staff/auth/password?x=1",
      body: '{"email":"a@b.sa"}',
    });
  });

  it("passes only the allowed request headers, the client address unchanged", async () => {
    await forward(
      new Request(`${WEB}/v1/staff/me`, {
        headers: {
          cookie: "__Host-qs_session=abc",
          origin: WEB,
          "x-forwarded-for": "203.0.113.9, 198.51.100.1",
          "x-forwarded-host": "evil.example",
          "x-internal-secret": "nope",
          authorization: "Bearer stolen",
          "idempotency-key": "key-1",
        },
      }),
      options(),
    );
    const headers = api.seen[0]?.headers ?? {};
    expect(headers).toMatchObject({
      cookie: "__Host-qs_session=abc",
      origin: WEB,
      "x-forwarded-for": "203.0.113.9, 198.51.100.1",
      "idempotency-key": "key-1",
    });
    expect(headers["x-forwarded-host"]).toBeUndefined();
    expect(headers["x-internal-secret"]).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["host"]).toBe(new URL(api.origin).host);
  });

  it("returns every set-cookie and only the allowed response headers", async () => {
    api.answer((_request, response) => {
      response.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      response.setHeader("x-request-id", "req-9");
      response.setHeader("retry-after", "30");
      response.setHeader("x-powered-by", "secret-stack");
      response.writeHead(429, { "content-type": "application/json" }).end("{}");
    });
    const response = await forward(new Request(`${WEB}/v1/staff/me`), options());
    expect(response.status).toBe(429);
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(response.headers.get("x-request-id")).toBe("req-9");
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("x-powered-by")).toBeNull();
  });

  it("answers 204 with no body", async () => {
    api.answer((_request, response) => response.writeHead(204).end());
    const response = await forward(
      new Request(`${WEB}/v1/staff/auth/sign-out`, { method: "POST" }),
      options(),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("refuses a body above the cap before calling the API", async () => {
    const response = await forward(
      new Request(`${WEB}/v1/staff/auth/password`, { method: "POST", body: "x".repeat(1_025) }),
      options(),
    );
    expect(response.status).toBe(413);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "payload_too_large",
    });
    expect(api.seen).toEqual([]);
  });

  it("answers 400 with the error body when the browser's body breaks off, without calling the API", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"pass'));
        controller.error(new Error("connection reset"));
      },
    });
    const response = await forward(
      new Request(`${WEB}/v1/staff/auth/password`, {
        method: "POST",
        body: broken,
        duplex: "half",
      } as RequestInit),
      options(),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "invalid_request" });
    expect(api.seen).toEqual([]);
    expect(logged).toEqual([
      {
        event: "api_forward_failed",
        method: "POST",
        path: "/v1/staff/auth/password",
        reason: "body_unreadable",
      },
    ]);
  });

  it.each([
    "/v1/%2e%2e/healthz",
    "/v1/staff/%2E%2E/%2E%2E/readyz",
    "/v1/staff%2fme",
    "/v1/staff%5c..%5creadyz",
    "/healthz",
    "/v1",
    "/v2/anything",
  ])("never reaches anything outside /v1 (%s)", async (path) => {
    const response = await forward(new Request(`${WEB}${path}`), options());
    expect(response.status).toBe(404);
    expect(api.seen).toEqual([]);
  });

  it("answers 502 with the error body on a timeout, and logs no body, cookie or query", async () => {
    api.answer(() => undefined);
    const response = await forward(
      new Request(`${WEB}/v1/staff/auth/password?token=secret`, {
        method: "POST",
        headers: { cookie: "__Host-qs_session=abc" },
        body: '{"password":"hunter2"}',
      }),
      options({ timeoutMs: 100 }),
    );
    expect(response.status).toBe(502);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "api_unavailable" });
    expect(logged).toEqual([
      {
        event: "api_forward_failed",
        method: "POST",
        path: "/v1/staff/auth/password",
        reason: "timeout",
      },
    ]);
  });

  it("answers 502 when the API cannot be reached at all", async () => {
    const response = await forward(
      new Request(`${WEB}/v1/staff/me`),
      options({ apiOrigin: "http://127.0.0.1:9" }),
    );
    expect(response.status).toBe(502);
    expect(logged[0]).toMatchObject({ reason: "unreachable" });
  });
});
