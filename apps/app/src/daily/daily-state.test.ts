import type { DailyChallenge, DailyWordGame } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  answeredCount,
  keyMarks,
  marksOf,
  nextAttempt,
  nextQuestion,
  readView,
  withAnswer,
  withGuess,
  wordIdFor,
  wordLanguage,
} from "#src/daily/daily-state.ts";

const period = { startsOn: "2026-10-27", endsOn: "2026-10-27" };
const question = (position: number, answered: DailyChallenge["questions"][number]["answered"]) => ({
  id: `00000000-0000-4000-8000-00000000000${position}`,
  position,
  prompt: { ar: "س", en: "Q" },
  options: [
    { ar: "أ", en: "A" },
    { ar: "ب", en: "B" },
  ],
  answered,
});
const challenge = (answers: DailyChallenge["questions"][number]["answered"][]): DailyChallenge => ({
  id: 1,
  period,
  sponsor: null,
  questions: answers.map((answered, index) => question(index + 1, answered)),
  finished: null,
});
const right = { choice: 1, correct: true, right: 1 };
const reply = (
  position: number,
  correct: boolean,
  finished: DailyChallenge["finished"] = null,
) => ({
  answer: { position, choice: correct ? 1 : 2, correct, right: 1 },
  finished,
  levelUp: null,
  dailyStreak: null,
  replayed: false,
});

describe("what a screen shows for a read", () => {
  const held = { challenge: null, word: null };

  it("loads while nothing is held and nothing has failed", () => {
    expect(readView(null, false)).toEqual({ screen: "loading", banner: false });
  });

  it("shows the full error only when no game is held", () => {
    expect(readView(null, true)).toEqual({ screen: "error", banner: false });
  });

  it("keeps a held game when a later read fails, with a banner", () => {
    expect(readView(held, true)).toEqual({ screen: "game", banner: true });
  });

  it("shows a held game with no banner when the read is fine", () => {
    expect(readView(held, false)).toEqual({ screen: "game", banner: false });
  });
});

describe("the challenge", () => {
  it("shows the first question not answered, in order", () => {
    const shuffled = challenge([right, null, null]);
    shuffled.questions.reverse();
    expect(nextQuestion(shuffled)?.position).toBe(2);
    expect(nextQuestion(challenge([null, null, null]))?.position).toBe(1);
  });

  it("has no next question once all three are answered", () => {
    expect(nextQuestion(challenge([right, right, right]))).toBeUndefined();
    expect(answeredCount(challenge([right, null, right]))).toBe(2);
  });

  it("writes an answer into its own position only", () => {
    const next = withAnswer(challenge([null, null, null]), reply(2, false));
    expect(next.questions.map((q) => q.answered)).toEqual([
      null,
      { choice: 2, correct: false, right: 1 },
      null,
    ]);
    expect(next.finished).toBeNull();
  });

  it("takes the finish from the last answer and keeps it after a replay", () => {
    const finished = { correct: 2, xp: 40 };
    const done = withAnswer(challenge([right, right, null]), reply(3, false, finished));
    expect(done.finished).toEqual(finished);
    expect(withAnswer(done, reply(3, false)).finished).toEqual(finished);
  });
});

const wordGame = (over: Partial<DailyWordGame> = {}): DailyWordGame => ({
  period,
  length: 5,
  languages: ["ar", "en"],
  words: [
    { language: "ar", id: 3 },
    { language: "en", id: 4 },
  ],
  play: null,
  ...over,
});
const guessReply = (attempt: number, guess: string, marks: string, finished = null as never) => ({
  guess: { attempt, guess, marks },
  finished,
  levelUp: null,
  dailyStreak: null,
  replayed: false,
});

describe("the word language", () => {
  it("is the app's language when it has a word", () => {
    expect(wordLanguage(wordGame(), "ar")).toBe("ar");
    expect(wordLanguage(wordGame(), "en")).toBe("en");
  });

  it("is the language that has a word when the app's has none", () => {
    expect(wordLanguage(wordGame({ languages: ["en"] }), "ar")).toBe("en");
  });

  it("is the language already played, whatever the app's language", () => {
    const play = { language: "en" as const, wordId: 4, guesses: [], finished: null };
    expect(wordLanguage(wordGame({ play }), "ar")).toBe("en");
  });

  it("is null when no language has a word", () => {
    expect(wordLanguage(wordGame({ languages: [], words: [] }), "ar")).toBeNull();
  });

  it("finds the word to guess, and none in the other language once one is played", () => {
    expect(wordIdFor(wordGame(), "ar")).toBe(3);
    const play = { language: "en" as const, wordId: 4, guesses: [], finished: null };
    expect(wordIdFor(wordGame({ play }), "en")).toBe(4);
    expect(wordIdFor(wordGame({ play }), "ar")).toBeNull();
    expect(
      wordIdFor(wordGame({ languages: ["en"], words: [{ language: "en", id: 4 }] }), "ar"),
    ).toBeNull();
  });
});

describe("the guesses", () => {
  const chosen = { language: "en" as const, wordId: 4 };

  it("starts a play with the first guess", () => {
    const next = withGuess(wordGame(), chosen, guessReply(1, "crane", "01201"));
    expect(next.play).toEqual({
      language: "en",
      wordId: 4,
      guesses: [{ guess: "crane", marks: "01201" }],
      finished: null,
    });
    expect(nextAttempt(next)).toBe(2);
    expect(nextAttempt(wordGame())).toBe(1);
  });

  it("replaces an attempt it already holds, as a retried move returns the stored one", () => {
    const first = withGuess(wordGame(), chosen, guessReply(1, "crane", "01201"));
    const again = withGuess(first, chosen, guessReply(1, "crane", "01201"));
    expect(again.play?.guesses).toHaveLength(1);
  });

  it("takes the finish from the guess that ends the game", () => {
    const finished = { solved: true, attempts: 2, xp: 50, word: "slate" };
    let game = withGuess(wordGame(), chosen, guessReply(1, "crane", "01201"));
    game = withGuess(game, chosen, guessReply(2, "slate", "22222", finished as never));
    expect(game.play?.finished).toEqual(finished);
  });

  it("reads marks as numbers", () => {
    expect(marksOf("02120")).toEqual([0, 2, 1, 2, 0]);
  });

  it("gives each key its best mark: right place beats elsewhere beats absent", () => {
    const keys = keyMarks([
      { guess: "crane", marks: "01201" },
      { guess: "react", marks: "21000" },
    ]);
    expect(keys.get("r")).toBe(2);
    expect(keys.get("a")).toBe(2);
    expect(keys.get("c")).toBe(0);
    expect(keys.get("n")).toBe(0);
    expect(keys.get("e")).toBe(1);
    expect(keys.get("t")).toBe(0);
    expect(keys.get("z")).toBeUndefined();
  });
});
