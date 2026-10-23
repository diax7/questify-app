import { describe, expect, it } from "vitest";
import { resetLabel } from "#src/event/reset.ts";

const NOW = Date.parse("2026-10-24T10:00:00Z");

describe("resetLabel", () => {
  it("says a daily reset with the time left, in each language", () => {
    const at = "2026-10-25T01:00:00Z";
    expect(resetLabel({ refresh: "daily", at }, NOW, "en")).toEqual({
      key: "questsTab.category.resetsDaily",
      values: { span: "15 hours" },
    });
    expect(resetLabel({ refresh: "daily", at }, NOW, "ar")).toEqual({
      key: "questsTab.category.resetsDaily",
      values: { span: "15 ساعة" },
    });
  });

  it("says a weekly reset in days", () => {
    expect(resetLabel({ refresh: "weekly", at: "2026-10-27T11:00:00Z" }, NOW, "en")).toEqual({
      key: "questsTab.category.resetsWeekly",
      values: { span: "3 days" },
    });
  });

  it("says soon under a minute, and when the phone's clock is past the reset", () => {
    expect(resetLabel({ refresh: "daily", at: "2026-10-24T10:00:30Z" }, NOW, "en")).toEqual({
      key: "questsTab.category.resetsDailySoon",
      values: undefined,
    });
    expect(resetLabel({ refresh: "weekly", at: "2026-10-24T09:00:00Z" }, NOW, "ar")).toEqual({
      key: "questsTab.category.resetsWeeklySoon",
      values: undefined,
    });
  });
});
