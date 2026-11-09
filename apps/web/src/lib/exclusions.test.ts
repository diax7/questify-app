import { describe, expect, it } from "vitest";
import { withExclusionAdded, withoutExclusion, type Exclusion } from "#src/lib/exclusions.ts";

const a: Exclusion = { id: "1", kind: "phone", value: "***1234" };
const b: Exclusion = { id: "2", kind: "email_domain", value: "example.com" };

describe("withExclusionAdded", () => {
  it("puts the new entry first", () => {
    expect(withExclusionAdded([a], b)).toEqual([b, a]);
  });

  it("starts a list that was not loaded", () => {
    expect(withExclusionAdded(null, a)).toEqual([a]);
  });

  it("replaces an entry of the same id instead of repeating it", () => {
    const again: Exclusion = { id: "1", kind: "phone", value: "***9999" };
    expect(withExclusionAdded([b, a], again)).toEqual([again, b]);
  });
});

describe("withoutExclusion", () => {
  it("drops the entry of that id only", () => {
    expect(withoutExclusion([a, b], "1")).toEqual([b]);
    expect(withoutExclusion([a, b], "9")).toEqual([a, b]);
  });

  it("is empty for a list that was not loaded", () => {
    expect(withoutExclusion(null, "1")).toEqual([]);
  });
});
