import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp, invitationDepsOf, loggerOptions } from "./app";
import { MemoryIdempotencyStore } from "./idempotency-store";
import { RecordingEmailSender, testConfig } from "#test/support/auth-app";

let app: FastifyInstance;

const poolThat = (query: () => Promise<unknown>): Pool => ({ query }) as unknown as Pool;

async function build(pool: Pool = poolThat(async () => ({ rows: [] }))): Promise<FastifyInstance> {
  app = buildApp({
    config: { ...testConfig(), releaseSha: "abc1234" },
    idempotencyStore: new MemoryIdempotencyStore(),
    pool,
    emailSender: new RecordingEmailSender(),
    breachCheck: async () => false,
    logger: false,
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await app.close();
});

describe("health", () => {
  it("answers /healthz with the running build", async () => {
    await build();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", release: "abc1234" });
  });

  it("answers /readyz ok when the database answers", async () => {
    await build();
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", checks: { database: "ok" } });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("answers /readyz 503 when the database does not", async () => {
    await build(
      poolThat(async () => {
        throw new Error("connection refused");
      }),
    );
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable", checks: { database: "down" } });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("applies the API conventions to health routes too", async () => {
    await build();
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-app-version": "0.9.0" },
    });
    expect(response.statusCode).toBe(426);
  });

  it("never caches a health answer", async () => {
    await build();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("request bodies", () => {
  it("refuses a plain-text body, because only JSON reaches a handler", async () => {
    await build();
    const response = await app.inject({
      method: "POST",
      url: "/v1/staff/auth/password",
      headers: { "content-type": "text/plain", origin: testConfig().auth.dashboardOrigin },
      payload: "email=a@x.sa&password=secret",
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
  });

  it.each([
    ["a __proto__ key", '{"__proto__": {"polluted": 1}, "phone": "0500000000"}'],
    ["a constructor.prototype key", '{"constructor": {"prototype": {"polluted": 1}}}'],
  ])("refuses a body with %s before any handler or database work", async (_name, payload) => {
    let queries = 0;
    await build(
      poolThat(async () => {
        queries += 1;
        return { rows: [] };
      }),
    );
    for (const url of ["/v1/auth/code", "/v1/public/invitation-open"]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload,
      });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(queries).toBe(0);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("pins the poisoning options, so a framework default change cannot loosen them", async () => {
    await build();
    expect(app.initialConfig.onProtoPoisoning).toBe("error");
    expect(app.initialConfig.onConstructorPoisoning).toBe("error");
  });

  it("refuses a repeated query key where the schema takes one value", async () => {
    await build();
    const response = await app.inject({ method: "GET", url: "/v1/config?event=a&event=b" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
  });
});

async function ipSeenBehind(forwardedFor: string, hops: number): Promise<string> {
  app = buildApp({
    config: { ...testConfig(), trustProxyHops: hops },
    idempotencyStore: new MemoryIdempotencyStore(),
    pool: poolThat(async () => ({ rows: [] })),
    emailSender: new RecordingEmailSender(),
    breachCheck: async () => false,
    logger: false,
  });
  app.get("/whoami", { config: { access: "public" } }, async (incoming) => ({ ip: incoming.ip }));
  await app.ready();
  const response = await app.inject({
    method: "GET",
    url: "/whoami",
    headers: { "x-forwarded-for": forwardedFor },
  });
  return response.json<{ ip: string }>().ip;
}

describe("proxy trust", () => {
  it("takes the address the nearest proxy saw, ignoring what the client put in front of it", async () => {
    expect(await ipSeenBehind("6.6.6.6, 203.0.113.9", 1)).toBe("203.0.113.9");
  });

  it("goes one hop further back when two proxies sit in front", async () => {
    expect(await ipSeenBehind("6.6.6.6, 203.0.113.9, 10.0.0.2", 2)).toBe("203.0.113.9");
  });

  it("trusts no header at all when no proxy is configured", async () => {
    expect(await ipSeenBehind("203.0.113.9", 0)).toBe("127.0.0.1");
  });
});

const requestAt = (method: string, url: string | undefined, extra: object = {}) =>
  ({
    method,
    url: "/the/filled/path/is/never/read?ignored=private_email",
    routeOptions: { url },
    ...extra,
  }) as unknown as Parameters<ReturnType<typeof loggerOptions>["serializers"]["req"]>[0];

describe("loggerOptions", () => {
  const base = testConfig();

  it("is quieter in production than in development", () => {
    expect(loggerOptions({ ...base, nodeEnv: "production" }).level).toBe("info");
    expect(loggerOptions({ ...base, nodeEnv: "development" }).level).toBe("debug");
    expect(loggerOptions({ ...base, nodeEnv: "test" }).level).toBe("debug");
  });

  it("logs a request as method and route pattern only, never the client address", () => {
    const { req } = loggerOptions(base).serializers;
    const request = requestAt("POST", "/v1/staff/auth/password", {
      ip: "203.0.113.9",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { cookie: "x" },
    });
    expect(req(request)).toEqual({ method: "POST", url: "/v1/staff/auth/password" });
  });

  it("writes the route pattern, so a code, a username or a query value in the path never reaches a log", () => {
    const { req } = loggerOptions(base).serializers;
    expect(req(requestAt("GET", "/v1/players/:username"))).toEqual({
      method: "GET",
      url: "/v1/players/:username",
    });
    expect(req(requestAt("GET", "/v1/rehearsals/:code"))).toEqual({
      method: "GET",
      url: "/v1/rehearsals/:code",
    });
    expect(req(requestAt("DELETE", "/v1/me/blocks/:username"))).toEqual({
      method: "DELETE",
      url: "/v1/me/blocks/:username",
    });
  });

  it("writes a path no route answers as `unmatched`, since a caller can type anything there (T-018)", () => {
    const { req } = loggerOptions(base).serializers;
    expect(req(requestAt("GET", undefined))).toEqual({ method: "GET", url: "unmatched" });
  });

  it("removes credentials, session cookies and idempotency keys from every log line", () => {
    expect(loggerOptions({ ...base, nodeEnv: "production" }).redact).toEqual([
      "req.headers.authorization",
      "req.headers.cookie",
      'req.headers["idempotency-key"]',
      'res.headers["set-cookie"]',
    ]);
  });
});

const pushReadyWith = (push: { apns: unknown; fcm: unknown }): boolean | undefined =>
  invitationDepsOf({
    config: { ...testConfig(), push: push as never },
    pool: poolThat(async () => ({ rows: [] })),
  }).pushReady;

describe("invitation deps", () => {
  const apns = { keyId: "K" } as never;
  const fcm = { projectId: "p" } as never;

  it.each([
    ["no provider is not ready", undefined, undefined, false],
    [
      "only APNs is not ready: Android players would get neither push nor SMS",
      apns,
      undefined,
      false,
    ],
    ["only FCM is not ready: iOS players would get neither push nor SMS", undefined, fcm, false],
    ["both providers is ready", apns, fcm, true],
  ])("%s", (_, apnsSettings, fcmSettings, ready) => {
    expect(pushReadyWith({ apns: apnsSettings, fcm: fcmSettings })).toBe(ready);
  });
});
