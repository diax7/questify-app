import { describe, expect, it } from "vitest";
import { switchRefusalOf } from "#src/control/pause";

describe("switchRefusalOf (T-603b)", () => {
  it("maps each refusal of the pause and skip doors to its answer", () => {
    expect(switchRefusalOf({ code: "AN404" })).toEqual({ kind: "not_found" });
    expect(switchRefusalOf({ code: "AQ404" })).toEqual({ kind: "not_found" });
    expect(switchRefusalOf({ code: "QE409" })).toEqual({ kind: "event_closed" });
    expect(switchRefusalOf({ code: "SP422" })).toEqual({ kind: "not_in_order" });
  });

  it("leaves anything else to be thrown", () => {
    expect(switchRefusalOf({ code: "40P01" })).toBeUndefined();
    expect(switchRefusalOf({})).toBeUndefined();
  });
});
