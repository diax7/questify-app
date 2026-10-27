import {
  DEFAULT_TERMS,
  MESSAGES,
  NO_OVERRIDES,
  createTranslator,
  type EventTerms,
  type Language,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import { withWords } from "#src/i18n/words.ts";
import {
  eventStreakOf,
  streakBonusLine,
  streakBonusPaidOf,
  streakCardText,
  streakHistoryLabel,
} from "#src/streaks/event-streak.ts";

const translate = createTranslator(MESSAGES, NO_OVERRIDES);
const tIn = (language: Language, terms: EventTerms = DEFAULT_TERMS) =>
  withWords((key, params) => translate(key, language, params), terms, language);

describe("the readers", () => {
  it("reads Home's streak and nothing from a missing or malformed one", () => {
    const streak = { days: 3, playedToday: true, closedToday: false, bonusPoints: 25 };
    expect(eventStreakOf(streak)).toEqual(streak);
    expect(eventStreakOf(null)).toBeNull();
    expect(eventStreakOf(undefined)).toBeNull();
    expect(eventStreakOf({ ...streak, days: "3" })).toBeNull();
    expect(eventStreakOf({ ...streak, bonusPoints: 0 })).toBeNull();
    expect(eventStreakOf({ days: 3 })).toBeNull();
  });

  it("reads a completion's streak bonus and nothing from a missing or malformed one", () => {
    expect(streakBonusPaidOf({ points: 25, days: 3 })).toEqual({ points: 25, days: 3 });
    expect(streakBonusPaidOf(null)).toBeNull();
    expect(streakBonusPaidOf(undefined)).toBeNull();
    expect(streakBonusPaidOf({ points: 25, days: 1 })).toBeNull();
    expect(streakBonusPaidOf({ points: "25", days: 3 })).toBeNull();
  });
});

describe("the success and history lines", () => {
  it("says the streak day and the points", () => {
    expect(streakBonusLine(tIn("en"), { points: 25, days: 3 })).toBe("Streak day 3! +25");
    expect(streakBonusLine(tIn("ar"), { points: 1250, days: 12 })).toBe(
      "اليوم 12 من السلسلة! ‎+1,250",
    );
    expect(streakHistoryLabel(tIn("en"), 4)).toBe("Streak bonus, day 4");
    expect(streakHistoryLabel(tIn("ar"), 4)).toBe("مكافأة السلسلة، اليوم 4");
  });
});

describe("streakCardText", () => {
  const open = { days: 3, playedToday: true, closedToday: false, bonusPoints: 25 };

  it("gives the headline, the detail, the bonus with the event's currency word, and one label", () => {
    const text = streakCardText(open, tIn("en"), DEFAULT_TERMS, "en");
    expect(text.headline).toBe("3 days in a row");
    expect(text.detail).toBe("You played today");
    expect(text.bonus).toBe("+25 points with your first quest each day, from day 2.");
    expect(text.label).toBe(
      "Day streak. 3 days in a row. You played today. +25 points with your first quest each day, from day 2",
    );
  });

  it("uses a renamed currency and quest word", () => {
    const terms: EventTerms = {
      ...DEFAULT_TERMS,
      currency: { ...DEFAULT_TERMS.currency, en: { one: "tulip", many: "tulips" } },
      quest: { ...DEFAULT_TERMS.quest, en: { one: "task", many: "tasks" } },
    };
    expect(streakCardText({ ...open, bonusPoints: 1 }, tIn("en", terms), terms, "en").bonus).toBe(
      "+1 tulip with your first task each day, from day 2.",
    );
  });

  it("has no bonus line when the organizer set none", () => {
    const none = { ...open, bonusPoints: null };
    expect(streakCardText(none, tIn("en"), DEFAULT_TERMS, "en").bonus).toBeNull();
  });

  it("puts the amount's sign first in an Arabic line, with Western digits", () => {
    const text = streakCardText({ ...open, bonusPoints: 1000 }, tIn("ar"), DEFAULT_TERMS, "ar");
    expect(text.bonus).toBe("نقاط: ‎+1,000 مع أول مهمة كل يوم، من اليوم الثاني.");
    expect(text.bonus).not.toMatch(/[٠-٩]/);
  });

  it("reads a closed day first, never inviting play", () => {
    const text = streakCardText(
      { days: 2, playedToday: false, closedToday: true, bonusPoints: null },
      tIn("en"),
      DEFAULT_TERMS,
      "en",
    );
    expect(text.detail).toBe("The event is closed today. Your streak is safe.");
    expect(text.headline).toBe("2 days in a row");
  });

  it("starts fresh at 0", () => {
    const text = streakCardText(
      { days: 0, playedToday: false, closedToday: false, bonusPoints: null },
      tIn("ar"),
      DEFAULT_TERMS,
      "ar",
    );
    expect(text.headline).toBeNull();
    expect(text.detail).toBe("ابدأ سلسلة جديدة اليوم");
    expect(text.label).toBe("سلسلة الأيام. ابدأ سلسلة جديدة اليوم");
  });
});
