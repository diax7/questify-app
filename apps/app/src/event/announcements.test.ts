import { describe, expect, it } from "vitest";
import { happeningNow, memberAnnouncementsOf } from "#src/event/announcements.ts";
import { readQuests } from "#src/event/quests-api.ts";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const past = "2026-10-29T11:00:00Z";
const later = "2026-10-29T13:00:00Z";
const rawQuest = (id: string, flash: unknown = null, boost: unknown = null) => ({
  id,
  title: { ar: "المهمة", en: id },
  description: { ar: null, en: null },
  type: "scan_qr",
  points: 10,
  repeatCap: 1,
  opensAt: null,
  closesAt: null,
  done: 0,
  earned: 0,
  state: "open",
  flash,
  boost,
});
const categories = (quests: unknown[], boost: unknown = null) =>
  readQuests({
    event: { statusNow: "live", timezone: "Asia/Riyadh" },
    categories: [{ id: "category", name: { ar: "فئة", en: "Category" }, quests, boost }],
  })?.categories ?? [];

describe("Home announcements and happening now", () => {
  it("reads bounded member rows in both languages, refuses unknown shapes", () => {
    const row = {
      id: "a0b0c0d0-0000-4000-8000-000000000001",
      title: { ar: "الغداء", en: "Lunch" },
      body: { ar: "القاعة", en: "Hall" },
      sentAt: later,
    };
    expect(memberAnnouncementsOf({ announcements: [row] })).toEqual([row]);
    expect(memberAnnouncementsOf({ announcements: [] })).toEqual([]);
    for (const body of [
      null,
      {},
      { announcements: [null] },
      { announcements: [{ ...row, body: "bad" }] },
    ])
      expect(memberAnnouncementsOf(body)).toBeUndefined();
  });
  it("shows long-running flash quests, not only the live feed's first 15 minutes", () => {
    const found = categories([
      rawQuest("running", { closesAt: later }),
      rawQuest("expired", { closesAt: past }),
      rawQuest("ordinary"),
    ]);
    expect(happeningNow(found, NOW).map((row) => row.id)).toEqual(["flash:running"]);
    expect(happeningNow(found, Date.parse(later))).toEqual([]);
  });
  it("deduplicates quest-level boosts and reads a category-level boost even without quests", () => {
    const boost = { multiplier: 2, endsAt: later };
    const found = categories([rawQuest("one", null, boost), rawQuest("two", null, boost)], boost);
    expect(happeningNow(found, NOW).map((row) => row.id)).toEqual(["boost:category"]);
    expect(happeningNow(categories([], boost), NOW)).toHaveLength(1);
    expect(happeningNow(categories([rawQuest("one", null, boost)]), NOW)).toHaveLength(1);
    expect(happeningNow(categories([], { ...boost, endsAt: past }), NOW)).toEqual([]);
    expect(happeningNow([], NOW)).toEqual([]);
  });
});
