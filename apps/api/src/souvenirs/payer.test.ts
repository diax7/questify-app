import { describe, expect, it } from "vitest";
import { paySouvenirs } from "#src/souvenirs/payer";
import { fakePool, pgError } from "#test/support/fake-pool";

type Claim = { event_id: string; enrollment_id: string; generation: string; lease_token: string };
type Script = {
  /** The claims the n-th call (from 0) of `souvenir_claim_work` hands out. */
  claims: (call: number) => Claim[];
  /** What evaluating one enrollment answers: rows made, a database error, or null for no row at all. */
  evaluate?: (enrollment: string) => number | Error | null;
};
type Statement = { sql: string; values: readonly unknown[] };

const claim = (n: number): Claim => ({
  event_id: "e1",
  enrollment_id: `en${n}`,
  generation: `g${n}`,
  lease_token: `l${n}`,
});
const batches =
  (...lists: Claim[][]) =>
  (call: number) =>
    lists[call] ?? [];

/** A pool that answers the payer's statements from `script` and keeps each statement with its values. */
function payerPool(script: Script) {
  const statements: Statement[] = [];
  let claimCalls = 0;
  const { pool } = fakePool((sql, values) => {
    statements.push({ sql, values });
    if (sql.includes("souvenir_claim_work")) {
      const rows = script.claims(claimCalls);
      claimCalls += 1;
      return { rows };
    }
    if (sql.includes("souvenir_evaluate")) {
      const made = script.evaluate === undefined ? 1 : script.evaluate(String(values[0]));
      if (made instanceof Error) throw made;
      return { rows: made === null ? [] : [{ made }] };
    }
    return { rows: [] };
  });
  const of = (name: string) => statements.filter((one) => one.sql.includes(name));
  return { pool, of };
}

/** A clock the evaluations move: each evaluation sets it to the next reading. */
function clockPool(readings: number[], claimsToHandOut: Claim[]) {
  let clock = 0;
  let evaluated = 0;
  const payer = payerPool({
    claims: batches(claimsToHandOut),
    evaluate: () => {
      clock = readings[evaluated] ?? clock;
      evaluated += 1;
      return 1;
    },
  });
  return { ...payer, now: () => clock };
}
describe("paySouvenirs", () => {
  it("scans and claims for the event in batches of 20, then acknowledges each claim with its lease", async () => {
    const { pool, of } = payerPool({
      claims: batches([claim(1), claim(2)]),
      evaluate: (enrollment) => (enrollment === "en1" ? 2 : 0),
    });
    const totals = await paySouvenirs({ pool }, { eventId: "event-9" });
    expect(totals).toEqual({ granted: 2, skipped: 1, failed: 0 });
    expect(of("souvenir_scan_batch").map((one) => one.values)).toEqual([["event-9"], ["event-9"]]);
    expect(of("souvenir_claim_work").map((one) => one.values)).toEqual([
      ["event-9", 20],
      ["event-9", 20],
    ]);
    expect(of("souvenir_evaluate").map((one) => one.values)).toEqual([["en1"], ["en2"]]);
    expect(of("souvenir_ack").map((one) => one.values)).toEqual([
      ["en1", "g1", "l1", null],
      ["en2", "g2", "l2", null],
    ]);
    expect(of("souvenir_release")).toEqual([]);
  });

  it("works across every event when none is named", async () => {
    const { pool, of } = payerPool({ claims: batches() });
    expect(await paySouvenirs({ pool })).toEqual({ granted: 0, skipped: 0, failed: 0 });
    expect(of("souvenir_scan_batch").map((one) => one.values)).toEqual([[null]]);
    expect(of("souvenir_claim_work").map((one) => one.values)).toEqual([[null, 20]]);
    expect(of("souvenir_ack")).toEqual([]);
  });

  it("adds up what several batches grant and stops at the first empty one", async () => {
    const { pool, of } = payerPool({ claims: batches([claim(1), claim(2)], [claim(3)]) });
    expect(await paySouvenirs({ pool })).toEqual({ granted: 3, skipped: 0, failed: 0 });
    expect(of("souvenir_claim_work")).toHaveLength(3);
    expect(of("souvenir_ack")).toHaveLength(3);
  });

  it("counts an enrollment that answers no row as skipped, not failed", async () => {
    const { pool, of } = payerPool({ claims: batches([claim(1)]), evaluate: () => null });
    expect(await paySouvenirs({ pool })).toEqual({ granted: 0, skipped: 1, failed: 0 });
    expect(of("souvenir_ack")[0]?.values).toEqual(["en1", "g1", "l1", null]);
  });

  it.each([
    ["a five-character SQLSTATE", pgError({ code: "23505" }), "23505"],
    ["a five-character code of letters and digits", pgError({ code: "SV422" }), "SV422"],
    ["a code that is too long", pgError({ code: "SV4221" }), "SV500"],
    ["a code with a prefix before five characters", pgError({ code: "ab12345" }), "SV500"],
    ["a code that is too short", pgError({ code: "A1B2" }), "SV500"],
    ["a lower-case code", pgError({ code: "sv422" }), "SV500"],
    ["a network error code", pgError({ code: "ECONNRESET" }), "SV500"],
    ["an error with no code", new Error("connection lost, password=hunter2"), "SV500"],
  ])("acknowledges %s as the failure and goes on", async (_name, error, failure) => {
    const { pool, of } = payerPool({
      claims: batches([claim(1), claim(2)]),
      evaluate: (enrollment) => (enrollment === "en1" ? error : 1),
    });
    expect(await paySouvenirs({ pool })).toEqual({ granted: 1, skipped: 0, failed: 1 });
    expect(of("souvenir_ack").map((one) => one.values)).toEqual([
      ["en1", "g1", "l1", failure],
      ["en2", "g2", "l2", null],
    ]);
  });

  it("evaluates at most 500 enrollments in one run", async () => {
    const { pool, of } = payerPool({ claims: (call) => [claim(call)] });
    const totals = await paySouvenirs({ pool }, { now: () => 0 });
    expect(totals).toEqual({ granted: 500, skipped: 0, failed: 0 });
    expect(of("souvenir_evaluate")).toHaveLength(500);
    expect(of("souvenir_claim_work")).toHaveLength(500);
  });

  describe("with a time budget", () => {
    const five = [claim(1), claim(2), claim(3), claim(4), claim(5)];

    it("gives back the claims it did not reach, with their leases, once the budget is spent", async () => {
      const { pool, of, now } = clockPool([50, 100, 150], five);
      const totals = await paySouvenirs({ pool }, { budgetMs: 100, now });
      expect(totals).toEqual({ granted: 2, skipped: 0, failed: 0 });
      expect(of("souvenir_evaluate").map((one) => one.values)).toEqual([["en1"], ["en2"]]);
      expect(of("souvenir_ack")).toHaveLength(2);
      expect(of("souvenir_release").map((one) => one.values)).toEqual([
        [
          ["en3", "en4", "en5"],
          ["l3", "l4", "l5"],
        ],
      ]);
      expect(of("souvenir_claim_work")).toHaveLength(1);
    });

    it("keeps working while the clock is one tick short of the budget", async () => {
      const { pool, of, now } = clockPool([50, 99], five);
      await paySouvenirs({ pool }, { budgetMs: 100, now });
      expect(of("souvenir_evaluate")).toHaveLength(5);
      expect(of("souvenir_release")).toEqual([]);
    });

    it("defaults to a budget of two seconds", async () => {
      const { pool, of, now } = clockPool([1999, 2000], five);
      const totals = await paySouvenirs({ pool }, { now });
      expect(totals.granted).toBe(2);
      expect(of("souvenir_release").map((one) => one.values[0])).toEqual([["en3", "en4", "en5"]]);
    });

    it("claims no further batch once the budget ran out as the last claim finished", async () => {
      const { pool, of, now } = clockPool([50, 100], [claim(1), claim(2)]);
      const totals = await paySouvenirs({ pool }, { budgetMs: 100, now });
      expect(totals.granted).toBe(2);
      expect(of("souvenir_claim_work")).toHaveLength(1);
      expect(of("souvenir_release")).toEqual([]);
    });
  });
});
