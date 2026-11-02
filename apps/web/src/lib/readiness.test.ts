import { READINESS_KEYS, READINESS_LINES, MESSAGES, type ReadinessItem } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { translatorFor } from "#src/lib/language.ts";
import {
  READINESS_PAGES,
  byUrgency,
  itemLine,
  itemTitle,
  readinessHref,
} from "#src/lib/readiness.ts";

const item = (
  key: ReadinessItem["key"],
  line: ReadinessItem["line"],
  status: ReadinessItem["status"],
  count = 0,
): ReadinessItem => ({ key, line, status, count });

describe("the checklist's links", () => {
  it("has a page for every item and builds the address from the event's", () => {
    expect(Object.keys(READINESS_PAGES).toSorted()).toEqual([...READINESS_KEYS].toSorted());
    const base = "/en/organizers/o1/events/e1";
    expect(readinessHref(base, "quests")).toBe(`${base}/quests`);
    expect(readinessHref(base, "rehearsal")).toBe(`${base}#rehearsal-title`);
    expect(readinessHref(base, "dates")).toBe(base);
  });
});

describe("the checklist's words", () => {
  it("has an Arabic and an English text for every item and line", () => {
    for (const key of READINESS_KEYS) {
      const text = MESSAGES[`readiness.item.${key}`];
      expect(text.ar.length, key).toBeGreaterThan(0);
      expect(text.en.length, key).toBeGreaterThan(0);
    }
    for (const line of READINESS_LINES) {
      const text = MESSAGES[`readiness.line.${line}`];
      expect(text.ar.length, line).toBeGreaterThan(0);
      expect(text.en.length, line).toBeGreaterThan(0);
    }
  });

  it("reads a rehearsal that was not run as missing", () => {
    const missing = item("rehearsal", "rehearsal.missing", "warning");
    expect(itemTitle(translatorFor("en"), missing)).toBe("Rehearsal run");
    expect(itemLine(translatorFor("en"), missing, "en")).toBe("Missing");
  });

  it("shows a number with Western digits in both languages and fills the event's own word for a quest", () => {
    const ready = item("quests", "quests.ready", "done", 12);
    expect(itemLine(translatorFor("en"), ready, "en")).toBe("Playable quests: 12");
    expect(itemLine(translatorFor("ar"), ready, "ar")).toContain("12");
    expect(itemLine(translatorFor("ar"), ready, "ar")).not.toMatch(/[٠-٩]/);
    expect(itemTitle(translatorFor("en"), ready)).toBe("Quests");
    const partial = item("setup", "setup.partial", "warning", 4);
    expect(itemLine(translatorFor("en"), partial, "en")).toBe("Steps decided: 4 of 10");
  });
});

describe("the checklist's order", () => {
  it("puts what blocks first, then warnings, then what is done, keeping the list's order inside each", () => {
    const items = [
      item("dates", "dates.set", "done"),
      item("activation", "activation.pending", "warning"),
      item("quests", "quests.none", "blocking"),
      item("rewards", "rewards.none", "warning"),
      item("rules", "rules.set", "done"),
      item("desk", "desk.missing", "blocking"),
    ];
    expect(byUrgency(items).map((entry) => entry.key)).toEqual([
      "quests",
      "desk",
      "activation",
      "rewards",
      "dates",
      "rules",
    ]);
  });
});
