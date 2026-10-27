import { MESSAGES, NO_OVERRIDES, createTranslator, type Language } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { dailyStreakOf, dailyStreakText, streakNotices } from "#src/streaks/daily-streak.ts";

const translate = createTranslator(MESSAGES, NO_OVERRIDES);
const tIn =
  (language: Language) =>
  (key: Parameters<typeof translate>[0], params?: Record<string, string | number>) =>
    translate(key, language, params);

describe("dailyStreakOf", () => {
  it("reads the profile's daily streak and nothing from a missing or malformed one", () => {
    const streak = { days: 5, today: true, next: { days: 7, xp: 100 } };
    expect(dailyStreakOf(streak)).toEqual(streak);
    expect(dailyStreakOf({ days: 0, today: false, next: null })).toEqual({
      days: 0,
      today: false,
      next: null,
    });
    expect(dailyStreakOf(null)).toBeNull();
    expect(dailyStreakOf(undefined)).toBeNull();
    expect(dailyStreakOf({ days: 5 })).toBeNull();
    expect(dailyStreakOf({ ...streak, today: "yes" })).toBeNull();
  });
});

describe("dailyStreakText", () => {
  it("says the length, today and the next reward in English", () => {
    const streak = { days: 5, today: true, next: { days: 7, xp: 100 } };
    expect(dailyStreakText(streak, tIn("en"), "en")).toEqual({
      headline: "5 days in a row",
      detail: "You played today",
      next: "Next reward: +100 XP at 7 days",
      label: "Your streak. 5 days in a row. You played today. Next reward: +100 XP at 7 days",
    });
  });

  it("says them in Arabic with the sign first and Western digits", () => {
    const streak = { days: 2, today: false, next: { days: 3, xp: 50 } };
    const text = dailyStreakText(streak, tIn("ar"), "ar");
    expect(text.headline).toBe("يومان على التوالي");
    expect(text.detail).toBe("العب اليوم لتواصل السلسلة");
    expect(text.next).toBe("المكافأة التالية: ‎+50 XP عند 3 أيام");
  });

  it("has no next reward after the last milestone and starts fresh at 0", () => {
    const text = dailyStreakText({ days: 0, today: false, next: null }, tIn("en"), "en");
    expect(text).toEqual({
      headline: null,
      detail: "Start a new streak today",
      next: null,
      label: "Your streak. Start a new streak today",
    });
  });
});

describe("streakNotices", () => {
  const paid = {
    days: 7,
    today: true,
    next: null,
    rewards: [
      { days: 3, xp: 50 },
      { days: 7, xp: 100 },
    ],
  };

  it("makes one toast for each milestone the sync paid", () => {
    expect(streakNotices(paid, tIn("en"), "en")).toEqual([
      "Streak of 3 days! +50 XP",
      "Streak of 7 days! +100 XP",
    ]);
    expect(streakNotices(paid, tIn("ar"), "ar")).toEqual([
      "سلسلة 3 أيام! ‎+50 XP",
      "سلسلة 7 أيام! ‎+100 XP",
    ]);
  });

  it("uses the singular noun from eleven days on in Arabic", () => {
    const notice = streakNotices({ ...paid, rewards: [{ days: 14, xp: 150 }] }, tIn("ar"), "ar");
    expect(notice).toEqual(["سلسلة 14 يومًا! ‎+150 XP"]);
  });

  it("makes none when nothing was paid or the streak is off", () => {
    expect(streakNotices({ ...paid, rewards: [] }, tIn("en"), "en")).toEqual([]);
    expect(streakNotices(null, tIn("en"), "en")).toEqual([]);
  });
});
