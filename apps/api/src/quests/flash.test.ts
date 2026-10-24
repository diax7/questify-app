import { describe, expect, it } from "vitest";
import { endFlash, flashRefusalOf, launchFlash } from "#src/quests/flash";
import { fakePool, pgError } from "#test/support/fake-pool";

const CONTEXT = {
  organizerId: "11111111-1111-4111-8111-111111111111",
  staffUserId: "22222222-2222-4222-8222-222222222222",
} as const;
const OPENS = new Date("2030-11-01T07:00:00.000Z");
const CLOSES = new Date("2030-11-01T07:10:00.000Z");

describe("the flash refusals (migration 0055)", () => {
  it.each([
    [{ code: "AN404" }, { kind: "not_found" }],
    [{ code: "FN422" }, { kind: "not_flash" }],
    [{ code: "FE409", detail: "event_not_live" }, { kind: "event_not_live" }],
    [{ code: "FF403", detail: "feature_off" }, { kind: "feature_off" }],
    [{ code: "FL409", detail: "already_launched" }, { kind: "already_launched" }],
    [{ code: "FL409", detail: "scheduled" }, { kind: "scheduled" }],
    [{ code: "FL409", detail: "community_locked" }, { kind: "community_locked" }],
    [{ code: "FL409", detail: "too_late" }, { kind: "too_late" }],
    [{ code: "FL409", detail: "not_started" }, { kind: "not_started" }],
  ])("maps %o", (pg, refusal) => {
    expect(flashRefusalOf(pg)).toEqual(refusal);
  });

  it("leaves anything else to the caller", () => {
    expect(flashRefusalOf({ code: "FL409", detail: "window" })).toBeUndefined();
    expect(flashRefusalOf({ code: "FL409" })).toBeUndefined();
    expect(flashRefusalOf({ code: "23505" })).toBeUndefined();
    expect(flashRefusalOf({})).toBeUndefined();
  });
});

describe("Launch and End now", () => {
  it("launches as the caller with the minutes and answers the window as ISO times", async () => {
    const fake = fakePool(() => ({
      rows: [{ opens_at: OPENS, closes_at: CLOSES, replayed: false }],
    }));
    const done = await launchFlash({ pool: fake.pool }, CONTEXT, {
      eventId: "e1",
      questId: "q1",
      minutes: 10,
      requestId: "r1",
    });
    expect(done).toEqual({
      kind: "done",
      value: { opensAt: OPENS.toISOString(), closesAt: CLOSES.toISOString(), replayed: false },
    });
    expect(fake.queries).toEqual(["SELECT * FROM launch_flash($1, $2, $3, $4)"]);
  });

  it("ends with the request's id, and turns a refusal into its kind", async () => {
    const seen: unknown[][] = [];
    const fake = fakePool((_sql, values) => {
      seen.push([...values]);
      throw pgError({ code: "FL409", detail: "not_started" });
    });
    const done = await endFlash({ pool: fake.pool }, CONTEXT, {
      eventId: "e1",
      questId: "q1",
      requestId: "r1",
    });
    expect(done).toEqual({ kind: "not_started" });
    expect(fake.queries).toEqual(["SELECT * FROM end_flash($1, $2, $3)"]);
    expect(seen).toEqual([["e1", "q1", "r1"]]);
  });

  it("throws any other error", async () => {
    const broken = pgError({ code: "XX000" });
    const fake = fakePool(() => {
      throw broken;
    });
    await expect(
      launchFlash({ pool: fake.pool }, CONTEXT, {
        eventId: "e1",
        questId: "q1",
        minutes: 5,
        requestId: "r1",
      }),
    ).rejects.toBe(broken);
  });
});
