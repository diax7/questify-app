import { describe, expect, it } from "vitest";
import { withReport } from "#src/lib/use-unsaved.ts";

describe("withReport", () => {
  it("adds a source that reports unsaved edits and drops one that no longer does", () => {
    const one = withReport(new Set(), "details", true);
    expect([...one]).toEqual(["details"]);
    const two = withReport(one, "rules", true);
    expect([...two].toSorted()).toEqual(["details", "rules"]);
    expect([...withReport(two, "details", false)]).toEqual(["rules"]);
  });

  it("returns the same set when the report changes nothing, so nothing renders again", () => {
    const held = new Set(["details"]);
    expect(withReport(held, "details", true)).toBe(held);
    expect(withReport(held, "rules", false)).toBe(held);
  });

  it("does not change the set it was given", () => {
    const held = new Set(["details"]);
    withReport(held, "rules", true);
    withReport(held, "details", false);
    expect([...held]).toEqual(["details"]);
  });
});
