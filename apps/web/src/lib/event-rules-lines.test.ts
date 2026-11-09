import { describe, expect, it } from "vitest";
import { rulesLinesOf, type RulesResult } from "#src/lib/event-rules.ts";

const found = (block: { ar: string[]; en: string[] } | null): RulesResult => ({
  kind: "found",
  rules: { block, text: { ar: null, en: null } },
});

describe("rulesLinesOf", () => {
  it("takes the block's lines in the page's language", () => {
    const result = found({ ar: ["سطر"], en: ["A line", "Another"] });
    expect(rulesLinesOf(result, "en")).toEqual(["A line", "Another"]);
    expect(rulesLinesOf(result, "ar")).toEqual(["سطر"]);
  });

  it("is null without a block", () => {
    expect(rulesLinesOf(found(null), "en")).toBeNull();
  });

  it("is null for every answer that is not the rules", () => {
    expect(rulesLinesOf({ kind: "throttled" }, "en")).toBeNull();
    expect(rulesLinesOf({ kind: "unavailable" }, "ar")).toBeNull();
    expect(rulesLinesOf({ kind: "not_found" }, "en")).toBeNull();
  });
});
