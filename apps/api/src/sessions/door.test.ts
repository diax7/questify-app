import type { SessionCheckInAnswer } from "@questify/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { createMyCodeKey, myCode } from "#src/quests/qr";
import { registerSessionDoorRoutes } from "#src/sessions/door";
import { fakePool, pgError } from "#test/support/fake-pool";

const SESSION = "22222222-2222-4222-8222-222222222222";
const EVENT = "44444444-4444-4444-8444-444444444444";
const OPERATOR = "11111111-1111-4111-8111-111111111111";
const SCANNED = "33333333-3333-4333-8333-333333333333";
const KEY = createMyCodeKey("a".repeat(40));
const WHO = { username: "sam", avatar: "fox" };

let app: FastifyInstance;
let logged: string[];

type Ask = (sql: string, values: readonly unknown[]) => { rows?: readonly unknown[] };

/** The door routes over a pool that records every query; a test header stands in for the player guard. */
function build(ask: Ask = () => ({ rows: [] })) {
  const seen: { sql: string; values: readonly unknown[] }[] = [];
  const { pool } = fakePool((sql, values) => {
    seen.push({ sql, values });
    return ask(sql, values);
  });
  logged = [];
  app = Fastify({
    logger: { level: "info", stream: { write: (line: string) => void logged.push(line) } },
  });
  registerConventions(app, {
    minAppVersion: "1.0.0",
    idempotencyStore: new MemoryIdempotencyStore(),
  });
  app.addHook("onRequest", async (request) => {
    const who = request.headers["x-test-player"];
    if (typeof who === "string") request.player = { id: who };
  });
  registerSessionDoorRoutes(app, { pool, myKey: KEY });
  return seen;
}

const answering =
  (answer: SessionCheckInAnswer): Ask =>
  () => ({ rows: [{ answer }] });

const scan = (code: string, signedIn = true) =>
  app.inject({
    method: "POST",
    url: `/v1/operator/sessions/${SESSION}/check-in`,
    headers: signedIn ? { "x-test-player": OPERATOR } : {},
    payload: { code },
  });

const list = (signedIn = true) =>
  app.inject({
    method: "GET",
    url: `/v1/operator/events/${EVENT}/sessions`,
    headers: signedIn ? { "x-test-player": OPERATOR } : {},
  });

const eventsLogged = (): Record<string, unknown>[] =>
  logged
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line["event"] === "operator.session_check_in_refused");

describe("the session door's routes", () => {
  afterEach(async () => {
    await app.close();
  });

  it("answers a walk-in with its flag, and every other outcome with no flag and no points", async () => {
    const seen = build(answering({ outcome: "checked_in", walkIn: true, points: 30, player: WHO }));
    const walkIn = await scan(myCode(KEY, SCANNED, 4));
    expect(walkIn.json()).toEqual({ result: "checked_in", walkIn: true, points: 30, player: WHO });
    expect(seen.at(-1)?.values).toEqual([SESSION, SCANNED, 4]);
    await app.close();

    build(answering({ outcome: "not_registered", player: WHO }));
    const bare = await scan(myCode(KEY, SCANNED, 1));
    expect(bare.json()).toEqual({
      result: "not_registered",
      walkIn: false,
      points: 0,
      player: WHO,
    });
  });

  it("never caches the door's answers", async () => {
    build(answering({ outcome: "checked_in", walkIn: false, points: 0, player: WHO }));
    expect((await scan(myCode(KEY, SCANNED, 1))).headers["cache-control"]).toBe(
      "private, no-store",
    );
    expect((await scan("not-a-code")).headers["cache-control"]).toBe("private, no-store");
    expect((await list()).headers["cache-control"]).toBe("private, no-store");
  });

  it("answers 401 and asks the database nothing when no player reaches a door", async () => {
    const seen = build();
    const refused = await scan(myCode(KEY, SCANNED, 1), false);
    expect([refused.statusCode, refused.json().code]).toEqual([401, "unauthenticated"]);
    const unlisted = await list(false);
    expect([unlisted.statusCode, unlisted.json().code]).toEqual([401, "unauthenticated"]);
    expect(seen).toEqual([]);
  });

  it("logs a code it cannot open by its problem alone, never the code, and asks the database nothing", async () => {
    const seen = build();
    const stranger = createMyCodeKey("b".repeat(40));
    const forged = myCode(stranger, SCANNED, 1);
    for (const code of ["not-a-code", forged]) {
      expect((await scan(code)).json()).toEqual({
        result: "refused",
        reason: "invalid_code",
        player: null,
      });
    }
    const problems = eventsLogged().map((line) => line["problem"]);
    expect(problems).toEqual(["not_questify", "forged"]);
    expect(logged.join("\n")).not.toContain(forged);
    expect(seen).toEqual([]);
  });

  it("rethrows an error that is not one of the database's refusals", async () => {
    build(() => {
      throw new Error("connection lost");
    });
    expect((await scan(myCode(KEY, SCANNED, 1))).statusCode).toBe(500);
    await app.close();

    build(() => {
      throw pgError({ code: "XX000" });
    });
    expect((await scan(myCode(KEY, SCANNED, 1))).statusCode).toBe(500);
  });

  it("shows red with the station scan's reason for a refusal the door names", async () => {
    build(() => {
      throw pgError({ code: "QN403", detail: "event_not_live" });
    });
    expect((await scan(myCode(KEY, SCANNED, 1))).json()).toEqual({
      result: "refused",
      reason: "event_not_live",
      player: null,
    });
  });
});
