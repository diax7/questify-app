import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { deviceErrorOf, inDevice } from "#src/devices/errors";

const answerOf = (code: string, detail?: string) => {
  const error = deviceErrorOf(detail === undefined ? { code } : { code, detail });
  return error === undefined
    ? undefined
    : [error.status, error.envelope.code, error.envelope.details];
};

describe("deviceErrorOf, migration 0057's refusals as HTTP answers", () => {
  it.each([
    ["DV401", undefined, 401, "device_unpaired"],
    ["DV404", undefined, 404, "unknown_code"],
    ["DN404", undefined, 404, "unknown_device"],
    ["DV409", "event_closed", 409, "event_closed"],
    ["DV409", "limit_reached", 409, "limit_reached"],
    ["DV409", "not_screen_qr", 409, "not_screen_qr"],
    ["DV409", "not_kiosk", 409, "not_kiosk"],
    ["DV409", "wrong_kind", 409, "wrong_kind"],
    ["DV409", "code_taken", 503, "busy"],
    ["DV503", undefined, 503, "busy"],
    ["OP403", undefined, 403, "not_operator"],
    ["OA403", undefined, 403, "ability_off"],
    ["OS403", undefined, 403, "outside_quests"],
    ["OQ404", undefined, 404, "not_found"],
    ["AN404", undefined, 404, "not_found"],
  ])("answers %s (%s) as %i %s", (code, detail, status, answer) => {
    expect(answerOf(code, detail)?.slice(0, 2)).toEqual([status, answer]);
  });

  it("names the field DV422 names, or kind when it names none", () => {
    expect(answerOf("DV422", "label")).toEqual([422, "invalid_device", { field: "label" }]);
    expect(answerOf("DV422")).toEqual([422, "invalid_device", { field: "kind" }]);
  });

  it("answers nothing for an unknown DV409 detail, a DV409 without one, or any other code", () => {
    expect(answerOf("DV409", "something_new")).toBeUndefined();
    expect(answerOf("DV409")).toBeUndefined();
    expect(answerOf("XX000")).toBeUndefined();
    expect(deviceErrorOf({})).toBeUndefined();
  });
});

/** Runs one door through inDevice on a pool whose door throws `error`. */
const run = (error: unknown) => {
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.startsWith("SELECT door")) {
          throw error;
        }
        return { rows: [] };
      },
      release: () => undefined,
    }),
  } as unknown as Pool;
  return inDevice(pool, {}, async (client) => {
    await client.query("SELECT door()");
  });
};

describe("inDevice", () => {
  it("throws a known refusal as its HTTP answer and anything else as it is", async () => {
    await expect(run(Object.assign(new Error("x"), { code: "DN404" }))).rejects.toMatchObject({
      status: 404,
      envelope: { code: "unknown_device" },
    });
    const other = Object.assign(new Error("boom"), { code: "57014" });
    await expect(run(other)).rejects.toBe(other);
  });
});
