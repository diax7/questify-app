import { DEFAULT_TERMS, MESSAGES, createTranslator, type Language } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { pollSaid, shareSaid, surveySaid, voteSaid } from "#src/event/play-words.ts";
import type { Voted } from "#src/event/plays.ts";

const translate = createTranslator(MESSAGES);
const tIn =
  (language: Language) =>
  (key: keyof typeof MESSAGES, params?: Readonly<Record<string, string | number>>) =>
    translate(key, language, params);

const voted: Voted = {
  kind: "voted",
  points: 10,
  replayed: false,
  levelUp: null,
  bonus: null,
  item: null,
  boost: null,
  firstBonus: null,
  streakBonus: null,
};
const again: Voted = { ...voted, points: 0, replayed: true };
const streakBonus = { points: 20, days: 4 };

const ENTRIES = [
  ["VoteEntry", voteSaid, "Your vote is in."],
  ["SurveyEntry", surveySaid, "Thanks, your answers are in."],
  ["ShareEntry", shareSaid, "Thanks for sharing."],
] as const;

describe.each(ENTRIES)("%s's text", (_name, said, thanks) => {
  it("says the points of a first award", () => {
    expect(said(tIn("en"), DEFAULT_TERMS, "en", voted)).toBe(`${thanks} +10 points`);
  });

  it("says a first 0-point award as +0, as before", () => {
    expect(said(tIn("en"), DEFAULT_TERMS, "en", { ...voted, points: 0 })).toBe(
      `${thanks} +0 points`,
    );
  });

  it("says already recorded, in both languages, for a replay that paid nothing", () => {
    expect(said(tIn("en"), DEFAULT_TERMS, "en", again)).toBe(`${thanks} Already recorded`);
    expect(said(tIn("ar"), DEFAULT_TERMS, "ar", again)).toMatch(/ سجّلنا هذا من قبل$/);
  });

  it("keeps a replay that paid showing its points", () => {
    expect(said(tIn("en"), DEFAULT_TERMS, "en", { ...again, points: 10 })).toBe(
      `${thanks} +10 points`,
    );
  });
});

describe("PollEntry's text", () => {
  const en = tIn("en");

  it("says the points of a first award, then a streak bonus", () => {
    expect(pollSaid(en, DEFAULT_TERMS, "en", voted)).toBe("Thanks, your vote is in. +10 points");
    expect(pollSaid(en, DEFAULT_TERMS, "en", { ...voted, streakBonus })).toBe(
      "Thanks, your vote is in. +10 points Streak day 4! +20",
    );
  });

  it("says only the thanks for a 0-point first award, or only the streak bonus it paid", () => {
    const free = { ...voted, points: 0 };
    expect(pollSaid(en, DEFAULT_TERMS, "en", free)).toBe("Thanks, your vote is in.");
    expect(pollSaid(en, DEFAULT_TERMS, "en", { ...free, streakBonus })).toBe(
      "Thanks, your vote is in. Streak day 4! +20",
    );
  });

  it("says already recorded, in both languages, for a replay that paid nothing", () => {
    expect(pollSaid(en, DEFAULT_TERMS, "en", again)).toBe(
      "Thanks, your vote is in. Already recorded",
    );
    expect(pollSaid(tIn("ar"), DEFAULT_TERMS, "ar", again)).toMatch(/ سجّلنا هذا من قبل$/);
    expect(pollSaid(en, DEFAULT_TERMS, "en", { ...again, streakBonus })).toBe(
      "Thanks, your vote is in. Already recorded",
    );
  });

  it("keeps a replay that paid showing its points", () => {
    expect(pollSaid(en, DEFAULT_TERMS, "en", { ...again, points: 10 })).toBe(
      "Thanks, your vote is in. +10 points",
    );
  });
});
