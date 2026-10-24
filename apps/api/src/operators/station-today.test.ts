import { describe, expect, it } from "vitest";
import { stationToday } from "#src/operators/station-today";
import { fakePool, pgError } from "#test/support/fake-pool";

const OPERATOR = "22222222-2222-4222-8222-222222222222";
const TARGET = {
  eventId: "33333333-3333-4333-8333-333333333333",
  questId: "77777777-7777-4777-8777-777777777777",
};

describe("stationToday (FR-928)", () => {
  it("reads the two counts as numbers, for the event and quest asked", async () => {
    const seen: unknown[][] = [];
    const { pool } = fakePool((_sql, values) => {
      seen.push([...values]);
      return { rows: [{ today: "40", last_hour: "6" }] };
    });
    expect(await stationToday({ pool }, OPERATOR, TARGET)).toEqual({
      kind: "counts",
      today: 40,
      lastHour: 6,
    });
    expect(seen).toEqual([[TARGET.eventId, TARGET.questId]]);
  });

  it.each([
    ["OP403", "not_operator"],
    ["OQ404", "not_station"],
    ["OS403", "outside_station"],
  ])("answers %s as %s", async (code, kind) => {
    const { pool } = fakePool(() => {
      throw pgError({ code });
    });
    expect(await stationToday({ pool }, OPERATOR, TARGET)).toEqual({ kind });
  });

  it("throws any other database error", async () => {
    const { pool } = fakePool(() => {
      throw pgError({ code: "57014" });
    });
    await expect(stationToday({ pool }, OPERATOR, TARGET)).rejects.toThrow("57014");
  });
});
