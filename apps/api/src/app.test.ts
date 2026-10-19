import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { MemoryIdempotencyStore } from "./idempotency-store";

let app: FastifyInstance;

async function build(): Promise<FastifyInstance> {
  app = buildApp({
    config: {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3000,
      minAppVersion: "1.0.0",
      releaseSha: "abc1234",
    },
    idempotencyStore: new MemoryIdempotencyStore(),
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

  it("answers /readyz and lists what it checked", async () => {
    await build();
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", checks: {} });
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
