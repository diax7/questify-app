import { describe, expect, it } from "vitest";
import { LiveEditError, PAST_POINTS_TYPES, liveEditRefusal } from "#src/quests/live-edits";

describe("liveEditRefusal (T-604)", () => {
  it("maps each refusal of the past, delete and impact doors to its answer", () => {
    expect(liveEditRefusal({ code: "AQ404" })).toEqual({ kind: "not_found" });
    expect(liveEditRefusal({ code: "AS409" })).toEqual({ kind: "event_not_live" });
    expect(liveEditRefusal({ code: "RF409" })).toEqual({ kind: "results_final" });
    expect(liveEditRefusal({ code: "AK422" })).toEqual({ kind: "key_reused" });
    expect(liveEditRefusal({ code: "AC409", hint: "20,400" })).toEqual({
      kind: "over_cap",
      limit: 20,
    });
    expect(liveEditRefusal({ code: "AC409" })).toEqual({ kind: "over_cap", limit: 0 });
    expect(liveEditRefusal({ code: "PX422" })).toEqual({ kind: "invalid", field: "apply" });
  });

  it("leaves anything else to be thrown", () => {
    expect(liveEditRefusal({ code: "40P01" })).toBeUndefined();
    expect(liveEditRefusal({})).toBeUndefined();
  });

  it("reaches only the types paid the quest's points per completion (Q-354)", () => {
    expect(PAST_POINTS_TYPES).toEqual(
      expect.arrayContaining([
        "scan_qr",
        "enter_code",
        "location",
        "vote",
        "survey",
        "share",
        "challenge",
        "passport",
        "meet",
      ]),
    );
    for (const type of ["submission", "quiz", "game"]) {
      expect(PAST_POINTS_TYPES).not.toContain(type);
    }
  });
});

describe("LiveEditError (T-604)", () => {
  it("carries the door's refusal and its cause", () => {
    const cause = { code: "AQ404" };
    const error = new LiveEditError({ kind: "not_found" }, cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.refusal).toEqual({ kind: "not_found" });
    expect(error.cause).toBe(cause);
  });
});
