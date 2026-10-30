import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { CHEER_FLOOD } from "#src/cheers/flood";
import { registerMemberCheerRoutes } from "#src/cheers/routes";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { fakePool, pgError } from "#test/support/fake-pool";

const EVENT = "22222222-2222-4222-8222-222222222222";
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "33333333-3333-4333-8333-333333333333";

let app: FastifyInstance;

/** The route over a pool that records every query; `answer` is the database's reply to a send. */
function build(answer: () => void = () => undefined, now: () => number = () => 30_000) {
  const { pool, queries } = fakePool(() => {
    answer();
    return { rows: [{ answer: { sent: true } }] };
  });
  app = Fastify();
  registerConventions(app, {
    minAppVersion: "1.0.0",
    idempotencyStore: new MemoryIdempotencyStore(),
  });
  app.addHook("onRequest", async (request) => {
    const who = request.headers["x-test-player"];
    if (typeof who === "string") request.player = { id: who };
  });
  registerMemberCheerRoutes(app, { pool }, now);
  return { queries };
}

const tap = (player: string) =>
  app.inject({
    method: "POST",
    url: `/v1/events/${EVENT}/cheers`,
    headers: { "x-test-player": player },
    payload: { reaction: "heart" },
  });

describe("POST /v1/events/:eventId/cheers, the flood counter in front (T-509 review)", () => {
  afterEach(async () => {
    await app.close();
  });

  it("refuses taps past the flood limit with Retry-After and asks the database nothing for them", async () => {
    const { queries } = build();
    for (let sent = 0; sent < CHEER_FLOOD.max; sent += 1) {
      expect((await tap(P1)).statusCode).toBe(201);
    }
    const asked = queries.length;
    expect(asked).toBe(CHEER_FLOOD.max);
    const flooded = await tap(P1);
    expect(flooded.statusCode).toBe(429);
    expect(flooded.json()).toMatchObject({ code: "too_many_attempts" });
    expect(flooded.headers["retry-after"]).toBe("30");
    expect(flooded.headers["cache-control"]).toBe("private, no-store");
    await tap(P1);
    expect(queries).toHaveLength(asked);
  });

  it("keeps another player free while one is refused", async () => {
    const { queries } = build();
    for (let sent = 0; sent <= CHEER_FLOOD.max; sent += 1) {
      await tap(P1);
    }
    expect((await tap(P2)).statusCode).toBe(201);
    expect(queries).toHaveLength(CHEER_FLOOD.max + 1);
  });

  it("still passes the database's own limit on, whose answer is the real one", async () => {
    build(() => {
      throw pgError({ code: "CH429", detail: "12" });
    });
    const slow = await tap(P1);
    expect(slow.statusCode).toBe(429);
    expect(slow.headers["retry-after"]).toBe("12");
  });

  it("starts counting afresh in the next minute", async () => {
    let at = 30_000;
    build(undefined, () => at);
    for (let sent = 0; sent <= CHEER_FLOOD.max; sent += 1) {
      await tap(P1);
    }
    expect((await tap(P1)).statusCode).toBe(429);
    at += 30_000;
    expect((await tap(P1)).statusCode).toBe(201);
  });

  it("answers 401 before counting anything when nobody is signed in", async () => {
    const { queries } = build();
    const response = await app.inject({
      method: "POST",
      url: `/v1/events/${EVENT}/cheers`,
      payload: { reaction: "heart" },
    });
    expect(response.statusCode).toBe(401);
    expect(queries).toEqual([]);
  });
});
