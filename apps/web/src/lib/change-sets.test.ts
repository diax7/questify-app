import type { ChangeSetItem } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { translatorFor } from "#src/lib/language.ts";
import { fieldLabel, readyIds, tally, valueText } from "#src/lib/change-sets.ts";

const t = translatorFor("en");

const item = (state: ChangeSetItem["state"], id: string): ChangeSetItem => ({
  id,
  op: "edit",
  target: "quest",
  name: null,
  state,
  diff: null,
  choices: {},
  problem: null,
});

describe("change set review helpers", () => {
  it("selects only the items that are ready now", () => {
    const items = [
      item("ready", "a"),
      item("invalid", "b"),
      item("stale", "c"),
      item("applied", "d"),
      item("failed", "e"),
      item("ready", "f"),
    ];
    expect(readyIds(items)).toEqual(["a", "f"]);
  });

  it("counts how many selected items ended each way", () => {
    expect(
      tally([
        { itemId: "a", status: "applied", error: null },
        { itemId: "b", status: "applied", error: null },
        { itemId: "c", status: "stale", error: null },
      ]),
    ).toEqual({ applied: 2, failed: 0, stale: 1 });
  });

  it("words a value of the change log as one short line", () => {
    expect(valueText(null, t)).toBe("—");
    expect(valueText(undefined, t)).toBe("—");
    expect(valueText(true, t)).toBe("Yes");
    expect(valueText(false, t)).toBe("No");
    expect(valueText(150, t)).toBe("150");
    expect(valueText({ ar: "هودي", en: "Hoodie" }, t)).toBe("هودي / Hoodie");
    expect(valueText({ ar: null, en: "Hoodie" }, t)).toBe("Hoodie");
    expect(valueText(["a", "b"], t)).toBe('["a","b"]');
  });

  it("names a field in the page's words, or by its own name when it has none", () => {
    expect(fieldLabel("quest", "titleEn", t)).toBe("Title in English");
    expect(fieldLabel("reward", "tags", t)).toBe("Tags");
    expect(fieldLabel("category", "somethingNew", t)).toBe("somethingNew");
  });
});
