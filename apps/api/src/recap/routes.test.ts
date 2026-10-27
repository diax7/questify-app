import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { recapOf, type RecapRow } from "#src/recap/recap";
import { registerRecapRoutes } from "#src/recap/routes";
import { fakePool, type FakeAnswer } from "#test/support/fake-pool";

const PLAYER = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const SIGNED_IN = { "x-test-player": "yes" };
const NO_STORE = "private, no-store";
const LANTERN = {
  id: "souvenir-lantern",
  kind: "frame",
  name: { ar: "فانوس", en: "Lantern" },
  visualKey: null,
};

const row = (fields: Partial<Record<keyof RecapRow, unknown>> = {}): RecapRow =>
  ({
    status_now: "ended",
    name: { ar: "ملتقى", en: "Meetup" },
    local_date: "2030-01-01",
    city: { ar: "الرياض", en: "Riyadh" },
    rank: 4,
    rank_state: "final",
    quests_done: 6,
    souvenirs: [LANTERN],
    ...fields,
  }) as RecapRow;

let app: FastifyInstance;

function build(answer: (sql: string, values: readonly unknown[]) => FakeAnswer) {
  const seen: { sql: string; values: readonly unknown[] }[] = [];
  const { pool } = fakePool((sql, values) => {
    seen.push({ sql, values });
    return answer(sql, values);
  });
  app = Fastify();
  registerConventions(app, {
    minAppVersion: "1.0.0",
    idempotencyStore: new MemoryIdempotencyStore(),
  });
  app.addHook("onRequest", async (request) => {
    if (request.headers["x-test-player"] !== undefined) request.player = { id: PLAYER };
  });
  registerRecapRoutes(app, { pool });
  return { seen };
}

const get = (url = `/v1/events/${EVENT}/recap`, headers: Record<string, string> = SIGNED_IN) =>
  app.inject({ method: "GET", url, headers });

describe("recapOf", () => {
  it("answers the event, the final rank, the quests done and the souvenirs", () => {
    expect(recapOf(EVENT, row())).toEqual({
      kind: "recap",
      recap: {
        event: {
          id: EVENT,
          name: { ar: "ملتقى", en: "Meetup" },
          date: "2030-01-01",
          city: { ar: "الرياض", en: "Riyadh" },
        },
        rank: { state: "final", value: 4 },
        questsDone: 6,
        souvenirs: [LANTERN],
      },
    });
  });

  it("gives no place while results are pending or for an unranked member", () => {
    for (const state of ["pending", "unranked"] as const) {
      const answer = recapOf(EVENT, row({ rank_state: state, rank: null }));
      expect(answer).toMatchObject({ kind: "recap", recap: { rank: { state, value: null } } });
    }
  });

  it("answers an archived event, and one with no city, quests or souvenirs", () => {
    expect(
      recapOf(EVENT, row({ status_now: "archived", city: null, quests_done: 0, souvenirs: [] })),
    ).toMatchObject({
      kind: "recap",
      recap: { event: { city: null }, questsDone: 0, souvenirs: [] },
    });
  });

  it("answers not ended before the end, and not found without a row", () => {
    for (const status of ["draft", "scheduled", "live"]) {
      expect(recapOf(EVENT, row({ status_now: status, rank_state: "live" }))).toEqual({
        kind: "not_ended",
      });
    }
    expect(recapOf(EVENT, undefined)).toEqual({ kind: "not_found" });
  });
});

describe("GET /v1/events/:eventId/recap", () => {
  afterEach(async () => {
    await app.close();
  });

  it("answers the caller's recap from event_recap, never cached", async () => {
    const { seen } = build(() => ({ rows: [row()] }));
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
    expect(response.json()).toMatchObject({ rank: { state: "final", value: 4 }, questsDone: 6 });
    expect(seen.map((one) => [one.sql, one.values])).toEqual([
      ["SELECT * FROM event_recap($1)", [EVENT]],
    ]);
  });

  it("answers 404 when event_recap has no row, never cached", async () => {
    build(() => ({ rows: [] }));
    const response = await get();
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "not_found" });
    expect(response.headers["cache-control"]).toBe(NO_STORE);
  });

  it("answers 409 not_ended with the recap's own words before the end", async () => {
    build(() => ({ rows: [row({ status_now: "live", rank_state: "live", rank: null })] }));
    const response = await get();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "not_ended",
      message: {
        ar: "يظهر ملخّصك بعد نهاية الفعالية.",
        en: "Your recap appears once the event ends.",
      },
    });
    expect(response.headers["cache-control"]).toBe(NO_STORE);
  });

  it("refuses a bad event id and asks the database nothing", async () => {
    const { seen } = build(() => ({ rows: [row()] }));
    expect((await get("/v1/events/not-a-uuid/recap")).statusCode).toBe(400);
    expect(seen).toEqual([]);
  });
});
