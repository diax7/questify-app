import { describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { fetchOwnDaily, ownDailyOf, postAnswer, postGuess } from "#src/daily/daily-api.ts";

const QUESTION = "7d1d2a4e-2c0f-4a35-9a51-0f3a2a6b9c11";
const period = { startsOn: "2026-10-27", endsOn: "2026-10-27" };
const challenge = {
  id: 4,
  period,
  sponsor: null,
  questions: [
    {
      id: QUESTION,
      position: 1,
      prompt: { ar: "سؤال", en: "Question" },
      options: [
        { ar: "أ", en: "A" },
        { ar: "ب", en: "B" },
      ],
      answered: null,
    },
  ],
  finished: null,
};
const word = {
  period,
  length: 5,
  languages: ["en"],
  words: [{ language: "en", id: 9 }],
  play: null,
};

const ok = (body: unknown): AuthedResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(),
});
const refused = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: null,
  details,
  headers: new Headers(),
});
const sessionOf = (answer: AuthedResult) => ({ request: vi.fn().mockResolvedValue(answer) });

describe("ownDailyOf", () => {
  it("reads both games", () => {
    expect(ownDailyOf({ challenge, word })).toEqual({ challenge, word });
  });

  it("keeps a game the server switched off as null", () => {
    expect(ownDailyOf({ challenge: null, word })).toEqual({ challenge: null, word });
  });

  it("drops a game it cannot read without hiding the other", () => {
    const odd = { ...word, length: 6 };
    expect(ownDailyOf({ challenge, word: odd })).toEqual({ challenge, word: null });
    expect(ownDailyOf({ challenge: { id: "x" }, word })).toEqual({ challenge: null, word });
  });

  it("tolerates a body with a game missing, as an older API sends", () => {
    expect(ownDailyOf({})).toEqual({ challenge: null, word: null });
  });

  it("is null for a body that is not an object", () => {
    expect(ownDailyOf(null)).toBeNull();
    expect(ownDailyOf("daily")).toBeNull();
    expect(ownDailyOf([])).toBeNull();
  });
});

describe("fetchOwnDaily", () => {
  it("asks for the caller's games", async () => {
    const session = sessionOf(ok({ challenge, word }));
    expect(await fetchOwnDaily(session)).toEqual({ challenge, word });
    expect(session.request).toHaveBeenCalledWith({ method: "GET", path: "/v1/me/daily" });
  });

  it("is null for a failure, never an empty pair of games", async () => {
    expect(await fetchOwnDaily(sessionOf(refused(500, "server_error")))).toBeNull();
    expect(await fetchOwnDaily(sessionOf(refused(404, "not_found")))).toBeNull();
    expect(await fetchOwnDaily(sessionOf({ kind: "network" }))).toBeNull();
  });
});

const answerReply = {
  answer: { position: 1, choice: 2, correct: false, right: 1 },
  finished: null,
  levelUp: null,
  dailyStreak: null,
  replayed: false,
};
const body = { challengeId: 4, questionId: QUESTION, position: 1, choice: 2 };

describe("postAnswer", () => {
  it("sends the question shown and the option chosen, and reads the reply", async () => {
    const session = sessionOf(ok(answerReply));
    expect(await postAnswer(session, body)).toEqual({ kind: "ok", reply: answerReply });
    expect(session.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/me/daily/challenge/answers",
      body,
    });
  });

  it.each([
    ["the round ended", refused(409, "daily_conflict", { reason: "period_over" }), "period_over"],
    ["changed content", refused(409, "daily_conflict", { reason: "changed" }), "changed"],
    [
      "a move out of turn",
      refused(409, "daily_conflict", { reason: "out_of_order" }),
      "out_of_order",
    ],
  ] as const)("answers a conflict: %s", async (_name, answer, reason) => {
    expect(await postAnswer(sessionOf(answer), body)).toEqual({ kind: "conflict", reason });
  });

  it.each([
    ["a switched-off game", refused(404, "daily_unavailable"), { kind: "unavailable" }],
    ["a rate limit", refused(429, "rate_limited"), { kind: "limited" }],
    ["a server fault", refused(500, "server_error"), { kind: "failed" }],
    ["a bad choice", refused(422, "invalid_answer", { field: "choice" }), { kind: "failed" }],
    [
      "a conflict with an odd reason",
      refused(409, "daily_conflict", { reason: "x" }),
      { kind: "failed" },
    ],
    ["a reply it cannot read", ok({ answer: {} }), { kind: "failed" }],
    ["no network", { kind: "network" } as AuthedResult, { kind: "network" }],
    ["an ended session", { kind: "signed_out" } as AuthedResult, { kind: "signed_out" }],
  ] as const)("answers %s", async (_name, answer, outcome) => {
    expect(await postAnswer(sessionOf(answer), body)).toEqual(outcome);
  });
});

const guessReply = {
  guess: { attempt: 1, guess: "crane", marks: "01201" },
  finished: null,
  levelUp: null,
  dailyStreak: null,
  replayed: false,
};
const guessBody = { wordId: 9, attempt: 1, guess: "crane" };

describe("postGuess", () => {
  it("sends the word shown, the attempt and the guess as typed", async () => {
    const session = sessionOf(ok(guessReply));
    expect(await postGuess(session, guessBody)).toEqual({ kind: "ok", reply: guessReply });
    expect(session.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/me/daily/word/guesses",
      body: guessBody,
    });
  });

  it.each(["length", "letters", "not_a_word"] as const)(
    "tells a refused guess (%s) apart from a conflict: no try was used",
    async (reason) => {
      const answer = refused(422, "invalid_guess", { reason });
      expect(await postGuess(sessionOf(answer), guessBody)).toEqual({ kind: "refused", reason });
    },
  );

  it("answers a conflict about the other language", async () => {
    const answer = refused(409, "daily_conflict", { reason: "other_language" });
    expect(await postGuess(sessionOf(answer), guessBody)).toEqual({
      kind: "conflict",
      reason: "other_language",
    });
  });

  it("answers an odd refusal reason as a failure", async () => {
    const answer = refused(422, "invalid_guess", { reason: "weird" });
    expect(await postGuess(sessionOf(answer), guessBody)).toEqual({ kind: "failed" });
  });
});
