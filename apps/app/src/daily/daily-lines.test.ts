import {
  createTranslator,
  MESSAGES,
  type DailyChallenge,
  type DailyWordGame,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  challengeCardLine,
  nextLine,
  questifyDayOf,
  wordCardLine,
} from "#src/daily/daily-lines.ts";

const translate = createTranslator(MESSAGES);
const en = (key: Parameters<typeof translate>[0], params?: Record<string, string | number>) =>
  translate(key, "en", params);
const ar = (key: Parameters<typeof translate>[0], params?: Record<string, string | number>) =>
  translate(key, "ar", params);

// 2026-10-27 is a Tuesday.
const at = (iso: string) => new Date(iso);

describe("the Questify day", () => {
  it("starts at 04:00 Riyadh, which is 01:00 UTC", () => {
    expect(questifyDayOf(at("2026-10-27T00:59:00Z"))).toBe("2026-10-26");
    expect(questifyDayOf(at("2026-10-27T01:00:00Z"))).toBe("2026-10-27");
    expect(questifyDayOf(at("2026-10-27T20:59:00Z"))).toBe("2026-10-27");
  });
});

describe("when the next one comes", () => {
  const daily = { endsOn: "2026-10-27" };

  it("says tomorrow when the period ends today", () => {
    const now = at("2026-10-27T09:00:00Z");
    expect(nextLine("challenge", daily, now, en)).toBe("The next challenge is tomorrow.");
    expect(nextLine("word", daily, now, ar)).toBe("الكلمة التالية غدًا.");
  });

  it("says tomorrow late at night before the 04:00 change too", () => {
    expect(nextLine("challenge", daily, at("2026-10-27T22:30:00Z"), en)).toBe(
      "The next challenge is tomorrow.",
    );
  });

  it("names the weekday of the next week's start for a weekly period", () => {
    // Weeks run Sunday to Saturday: Tuesday's week ends Saturday 2026-10-31, the next starts Sunday.
    const weekly = { endsOn: "2026-10-31" };
    const now = at("2026-10-27T09:00:00Z");
    expect(nextLine("challenge", weekly, now, en)).toBe("The next challenge is on Sunday.");
    expect(nextLine("word", weekly, now, ar)).toBe("الكلمة التالية يوم الأحد.");
  });

  it("says tomorrow on the last day of a weekly period", () => {
    expect(nextLine("word", { endsOn: "2026-10-31" }, at("2026-10-31T09:00:00Z"), en)).toBe(
      "The next word is tomorrow.",
    );
  });

  it("says next Sunday when today is the Sunday a week starts", () => {
    // Sunday 25th: the next start is Sunday 1 November, 7 days away, so "on Sunday" would mean today.
    const now = at("2026-10-25T09:00:00Z");
    const weekly = { endsOn: "2026-10-31" };
    expect(nextLine("challenge", weekly, now, en)).toBe("The next challenge is next Sunday.");
    expect(nextLine("challenge", weekly, now, ar)).toBe("التحدي التالي يوم الأحد القادم.");
  });

  it("never counts down", () => {
    const line = nextLine("challenge", { endsOn: "2026-10-31" }, at("2026-10-27T09:00:00Z"), en);
    expect(line).not.toMatch(/\d|hour|minute|left|remaining/i);
  });
});

const period = { startsOn: "2026-10-27", endsOn: "2026-10-27" };
const q = (position: number, answered: boolean) => ({
  id: `00000000-0000-4000-8000-00000000000${position}`,
  position,
  prompt: { ar: "س", en: "Q" },
  options: [
    { ar: "أ", en: "A" },
    { ar: "ب", en: "B" },
  ],
  answered: answered ? { choice: 1, correct: true, right: 1 } : null,
});
const challengeOf = (answered: number, finished: DailyChallenge["finished"] = null) => ({
  id: 1,
  period,
  sponsor: null,
  questions: [q(1, answered > 0), q(2, answered > 1), q(3, answered > 2)],
  finished,
});

describe("the challenge card", () => {
  it("invites a new player without naming an XP amount", () => {
    expect(challengeCardLine(challengeOf(0), en)).toBe("Answer three questions to earn XP.");
  });

  it("counts the answers so far", () => {
    expect(challengeCardLine(challengeOf(2), en)).toBe("2 of 3 answered");
    expect(challengeCardLine(challengeOf(1), ar)).toBe("أجبت عن 1 من 3");
  });

  it("says the score and the XP when done", () => {
    const line = challengeCardLine(challengeOf(3, { correct: 2, xp: 40 }), en);
    expect(line).toBe("Done: 2 of 3 right. +40 XP");
  });
});

const wordOf = (play: DailyWordGame["play"]): DailyWordGame => ({
  period,
  length: 5,
  languages: ["en"],
  words: [{ language: "en", id: 1 }],
  play,
});
const played = (
  guesses: number,
  finished: NonNullable<DailyWordGame["play"]>["finished"] = null,
) => ({
  language: "en" as const,
  wordId: 1,
  guesses: Array.from({ length: guesses }, () => ({ guess: "crane", marks: "00000" })),
  finished,
});

describe("the word card", () => {
  it("invites, counts tries, and says how it ended", () => {
    expect(wordCardLine(wordOf(null), en)).toBe("Guess the five-letter word to earn XP.");
    expect(wordCardLine(wordOf(played(2)), en)).toBe("2 of 6 tries used");
    const solved = { solved: true, attempts: 4, xp: 50, word: "slate" };
    expect(wordCardLine(wordOf(played(4, solved)), en)).toBe("Solved on try 4. +50 XP");
    const missed = { solved: false, attempts: 6, xp: 0, word: "slate" };
    expect(wordCardLine(wordOf(played(6, missed)), en)).toBe("You didn't get it this time.");
  });
});
