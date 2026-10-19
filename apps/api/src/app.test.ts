import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp, loggerOptions } from "./app";
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
});

async function ipSeenBehind(forwardedFor: string, hops: number): Promise<string> {
  app = buildApp({
    config: { ...testConfig(), trustProxyHops: hops },
    idempotencyStore: new MemoryIdempotencyStore(),
    pool: poolThat(async () => ({ rows: [] })),
    emailSender: new RecordingEmailSender(),
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

describe("loggerOptions", () => {
  const base = testConfig();

  it("is quieter in production than in development", () => {
    expect(loggerOptions({ ...base, nodeEnv: "production" }).level).toBe("info");
    expect(loggerOptions({ ...base, nodeEnv: "development" }).level).toBe("debug");
    expect(loggerOptions({ ...base, nodeEnv: "test" }).level).toBe("debug");
  });

  it("logs a request as method and path only, never the client address", () => {
    const { req } = loggerOptions(base).serializers;
    const request = {
      method: "POST",
      url: "/v1/staff/auth/password",
      ip: "203.0.113.9",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { cookie: "x" },
    } as unknown as Parameters<typeof req>[0];
    expect(req(request)).toEqual({ method: "POST", url: "/v1/staff/auth/password" });
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
