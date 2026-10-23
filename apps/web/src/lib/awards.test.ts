import { describe, expect, it } from "vitest";
import { capProblem, kindKey, pointsOf, reasonOk, whoOf } from "#src/lib/awards.ts";
import { translatorFor } from "#src/lib/language.ts";

const t = translatorFor("en");

describe("awards helpers", () => {
  it("labels each kind and falls back for an unknown one", () => {
    expect(kindKey("removal")).toBe("awards.kind.removal");
    expect(kindKey("redeem_return")).toBe("awards.kind.redeem_return");
    expect(kindKey("future_kind")).toBe("history.other");
  });

  it("names the operator by username, else the staff email, else nobody", () => {
    expect(whoOf({ operator: "sara", staff: null })).toBe("@sara");
    expect(whoOf({ operator: null, staff: "lead@team.sa" })).toBe("lead@team.sa");
    expect(whoOf({ operator: null, staff: null })).toBeNull();
  });

  it("takes whole points from 1 to 100000", () => {
    expect(pointsOf(" 50 ")).toBe(50);
    expect(pointsOf("1")).toBe(1);
    expect(pointsOf("100000")).toBe(100000);
    expect(pointsOf("0")).toBeUndefined();
    expect(pointsOf("100001")).toBeUndefined();
    expect(pointsOf("2.5")).toBeUndefined();
    expect(pointsOf("")).toBeUndefined();
  });

  it("takes a reason of 1 to 300 characters after trimming", () => {
    expect(reasonOk("  ")).toBe(false);
    expect(reasonOk("a")).toBe(true);
    expect(reasonOk("a".repeat(300))).toBe(true);
    expect(reasonOk("a".repeat(301))).toBe(false);
  });

  it("words an over-the-cap answer and leaves every other answer alone", () => {
    expect(
      capProblem({ code: "over_cap", details: { cap: "each", limit: 200, left: 450 } }, t),
    ).toBe("This is over the limit of 200 per award. Enter 200 or less.");
    expect(capProblem({ code: "over_cap", details: { cap: "day", limit: 500, left: 50 } }, t)).toBe(
      "You have 50 left today.",
    );
    expect(capProblem({ code: "over_cap" }, t)).toBeUndefined();
    expect(capProblem({ code: "reason_required", details: {} }, t)).toBeUndefined();
    expect(capProblem(null, t)).toBeUndefined();
    expect(capProblem("over_cap", t)).toBeUndefined();
  });
});
