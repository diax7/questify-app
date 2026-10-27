import { MESSAGES, NO_OVERRIDES, createTranslator, type Language } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { spokenLabel, streakLines, streakState } from "#src/streaks/lines.ts";

const translate = createTranslator(MESSAGES, NO_OVERRIDES);
const tIn =
  (language: Language) =>
  (key: Parameters<typeof translate>[0], params?: Record<string, string | number>) =>
    translate(key, language, params);

const streak = (days: number, playedToday: boolean, closedToday: boolean) => ({
  days,
  playedToday,
  closedToday,
});

describe("streakState", () => {
  it("reads a closed day before anything else, even with nothing played", () => {
    expect(streakState(streak(4, false, true))).toBe("closedSafe");
    expect(streakState(streak(0, false, true))).toBe("closed");
    expect(streakState(streak(4, true, true))).toBe("closedSafe");
  });

  it("then whether today counted, then whether a streak is alive", () => {
    expect(streakState(streak(3, true, false))).toBe("played");
    expect(streakState(streak(3, false, false))).toBe("keepGoing");
    expect(streakState(streak(0, false, false))).toBe("fresh");
  });
});

describe("streakLines", () => {
  it("says the length and one neutral line in English", () => {
    const t = tIn("en");
    expect(streakLines(streak(3, true, false), t, "en")).toEqual({
      headline: "3 days in a row",
      detail: "You played today",
    });
    expect(streakLines(streak(1, false, false), t, "en")).toEqual({
      headline: "1 day in a row",
      detail: "Play today to keep it going",
    });
  });

  it("starts a new streak without blame when it ended", () => {
    expect(streakLines(streak(0, false, false), tIn("en"), "en")).toEqual({
      headline: null,
      detail: "Start a new streak today",
    });
    expect(streakLines(streak(0, false, false), tIn("ar"), "ar")).toEqual({
      headline: null,
      detail: "ابدأ سلسلة جديدة اليوم",
    });
  });

  it("says a closed day keeps the streak safe", () => {
    expect(streakLines(streak(5, false, true), tIn("en"), "en").detail).toBe(
      "The event is closed today. Your streak is safe.",
    );
    expect(streakLines(streak(5, false, true), tIn("ar"), "ar").detail).toBe(
      "الفعالية مغلقة اليوم، وسلسلتك محفوظة.",
    );
    expect(streakLines(streak(0, false, true), tIn("en"), "en")).toEqual({
      headline: null,
      detail: "The event is closed today.",
    });
  });

  it("counts days in Arabic with the right plural and the subject's dual", () => {
    const t = tIn("ar");
    expect(streakLines(streak(2, true, false), t, "ar").headline).toBe("يومان على التوالي");
    expect(streakLines(streak(1, true, false), t, "ar").headline).toBe("يوم واحد على التوالي");
    expect(streakLines(streak(7, true, false), t, "ar").headline).toBe("7 أيام على التوالي");
    expect(streakLines(streak(12, true, false), t, "ar").headline).toBe("12 يومًا على التوالي");
  });

  it("never warns of a loss, counts down or sells anything, in either language", () => {
    const pattern =
      /\b(lose|lost|last chance|hurry|expires|ends in|buy|freeze|repair)\b|تخسر|ستفقد|تفقد|اشتر|ينتهي/i;
    const states = [streak(0, false, false), streak(9, false, false), streak(9, false, true)];
    for (const language of ["en", "ar"] as const) {
      for (const state of states) {
        const { headline, detail } = streakLines(state, tIn(language), language);
        expect(`${headline ?? ""} ${detail}`).not.toMatch(pattern);
      }
    }
  });
});

describe("spokenLabel", () => {
  it("joins the lines with a pause, drops full stops and skips empty ones", () => {
    expect(spokenLabel(["Day streak", null, "The event is closed today.", "+5 gems."])).toBe(
      "Day streak. The event is closed today. +5 gems",
    );
  });
});
