import {
  DEFAULT_TERMS,
  ENGINE_VERSIONS,
  LEVELS,
  MESSAGES,
  createTranslator,
  memoryMatchV1,
  replay,
  slidePuzzleV1,
  type GameTarget,
  type Language,
  type MessageKey,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import {
  actionLine,
  attemptsLine,
  levelLine,
  resendable,
  resultLine,
} from "#src/event/game-words.ts";
import {
  clockOffset,
  gameMemory,
  gameSheetOf,
  resultAnswerOf,
  roundAnswerOf,
  sendGameResult,
  sheetAction,
  startGameRound,
  windowOpen,
  type GameSheet,
  type PendingResult,
} from "#src/event/games.ts";
import { withWords } from "#src/i18n/words.ts";
import { drawable, faceUp, gateTap, secondsLeftOf } from "#src/games/round.ts";

const translate = createTranslator(MESSAGES);
const tIn = (language: Language) =>
  withWords(
    (key: MessageKey, values?: Readonly<Record<string, string | number>>) =>
      translate(key, language, values),
    DEFAULT_TERMS,
    language,
  );
const headers = new Headers();
const ok = (body: unknown, status = 200): AuthedResult => ({ kind: "ok", status, body, headers });
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
  headers,
});

const NOW = Date.parse("2030-01-01T10:00:00Z");
const SHEET_BODY = {
  game: "memory_match",
  level: "medium",
  params: LEVELS.memory_match.medium,
  target: { game: "memory_match", pairs: 8, maxMoves: 20 },
  attempts: 3,
  cooldownMinutes: null,
  used: 1,
  attemptsLeft: 2,
  passed: false,
  done: false,
  retryAt: null,
  open: null,
  last: null,
  serverNow: "2030-01-01T10:00:05Z",
};
const sheet = (fields: Partial<GameSheet> = {}): GameSheet => ({
  ...(gameSheetOf(SHEET_BODY, NOW) as GameSheet),
  ...fields,
});
const PENDING: PendingResult = {
  questId: "q1",
  roundId: "7",
  key: "k1",
  inputs: [{ t: 120, card: 3 }],
  claimed: { pairs: 0, moves: 0, ms: 120, lucky: 0 },
  deadlineAt: "2030-01-01T10:12:00Z",
  offsetMs: 0,
};

/** A short round's answer for the result lines. */
const short = (result: unknown, target: GameTarget) =>
  ({ kind: "short", result, target, attemptsLeft: 1 }) as const;

describe("the game sheet", () => {
  it("reads the sheet with the server's clock offset, and nothing malformed", () => {
    expect(gameSheetOf(SHEET_BODY, NOW)).toMatchObject({
      game: "memory_match",
      level: "medium",
      attempts: 3,
      attemptsLeft: 2,
      target: { pairs: 8, maxMoves: 20 },
      offsetMs: 5000,
    });
    expect(gameSheetOf({ ...SHEET_BODY, target: undefined }, NOW)).toMatchObject({
      target: { game: "memory_match", pairs: 8, maxMoves: 20 },
    });
    expect(gameSheetOf({ ...SHEET_BODY, game: 7 }, NOW)).toBeUndefined();
    expect(gameSheetOf(null, NOW)).toBeUndefined();
  });

  it("shows the update line, never 'failed', for a game this build cannot draw (CTO 3)", () => {
    expect(gameSheetOf({ ...SHEET_BODY, game: "snake", params: {} }, NOW)).toBe("update");
    expect(gameSheetOf({ ...SHEET_BODY, engineVersion: 2 }, NOW)).toBe("update");
    expect(gameSheetOf({ ...SHEET_BODY, engineVersion: 1 }, NOW)).toMatchObject({
      game: "memory_match",
    });
    expect(
      gameSheetOf(
        { ...SHEET_BODY, game: "catch", params: LEVELS.catch.easy, target: undefined },
        NOW,
      ),
    ).toMatchObject({ game: "catch", target: { game: "catch", caught: 20, items: 30 } });
    expect(
      gameSheetOf({ ...SHEET_BODY, game: "tap_rush", params: LEVELS.tap_rush.hard }, NOW),
    ).toMatchObject({ game: "tap_rush" });
    expect(clockOffset("2030-01-01T10:00:00Z", NOW + 2000)).toBe(-2000);
  });

  it("offers Retry instead of Play while a result waits, then Play, Passed, the attempts' end or the next try", () => {
    expect(sheetAction(sheet(), PENDING, NOW)).toEqual({ kind: "retry", pending: PENDING });
    expect(sheetAction(sheet(), undefined, NOW)).toEqual({ kind: "play" });
    expect(sheetAction(sheet({ passed: true }), undefined, NOW)).toEqual({ kind: "passed" });
    expect(sheetAction(sheet({ attempts: 1, attemptsLeft: 0 }), undefined, NOW)).toEqual({
      kind: "already_played",
    });
    expect(sheetAction(sheet({ attemptsLeft: 0 }), undefined, NOW)).toEqual({
      kind: "no_attempts",
    });
    const cooling = sheet({ attempts: null, attemptsLeft: null, retryAt: "2030-01-01T10:05:00Z" });
    expect(sheetAction(cooling, undefined, NOW)).toEqual({
      kind: "cooldown",
      retryAt: "2030-01-01T10:05:00Z",
    });
    // The server's clock decides: 5 minutes later on the server, the cooldown is over.
    expect(sheetAction({ ...cooling, offsetMs: 300_001 }, undefined, NOW)).toEqual({
      kind: "play",
    });
  });

  it("says the level, the attempts and why there is no Play, in both languages with Western digits", () => {
    const en = tIn("en");
    const ar = tIn("ar");
    expect(levelLine(en, "medium")).toBe("Level: Medium");
    expect(levelLine(ar, "hard")).toBe("المستوى: صعب");
    expect(levelLine(en, "legendary")).toBe("Level: legendary");
    expect(attemptsLine(en, sheet(), "en")).toBe("2 of 3 attempts left");
    expect(attemptsLine(ar, sheet(), "ar")).toBe("المحاولات المتبقية: 2 من 3");
    expect(attemptsLine(en, sheet({ attempts: null, attemptsLeft: null }), "en")).toBe(
      "Unlimited attempts",
    );
    expect(actionLine(en, { kind: "passed" }, "en", "Asia/Riyadh")).toBe("Passed");
    expect(actionLine(en, { kind: "already_played" }, "en", "Asia/Riyadh")).toBe("Already played");
    expect(actionLine(ar, { kind: "no_attempts" }, "ar", "Asia/Riyadh")).toBe("لم تتبقَّ محاولات");
    expect(
      actionLine(en, { kind: "cooldown", retryAt: "2030-01-01T11:05:00Z" }, "en", "Asia/Riyadh"),
    ).toContain("14:05");
    expect(actionLine(en, { kind: "play" }, "en", "Asia/Riyadh")).toBeNull();
  });
});

describe("issuing a round", () => {
  it("reads the round, the update answer and the refusals", () => {
    const round = ok(
      {
        roundId: "9",
        game: "slide_puzzle",
        level: "easy",
        seed: -44,
        params: LEVELS.slide_puzzle.easy,
        engineVersion: 1,
        deadlineAt: "2030-01-01T10:13:00Z",
        serverNow: "2030-01-01T10:00:00Z",
      },
      201,
    );
    expect(roundAnswerOf(round, "q1", NOW + 1000)).toEqual({
      kind: "round",
      round: {
        questId: "q1",
        roundId: "9",
        game: "slide_puzzle",
        level: "easy",
        seed: -44,
        params: LEVELS.slide_puzzle.easy,
        engineVersion: 1,
        deadlineAt: "2030-01-01T10:13:00Z",
        offsetMs: -1000,
      },
    });
    expect(roundAnswerOf(ok({ roundId: "9" }), "q1", NOW)).toEqual({ kind: "failed" });
    expect(roundAnswerOf(refused(426, "update_required"), "q1", NOW)).toEqual({ kind: "update" });
    expect(
      roundAnswerOf(refused(409, "game_refused", { reason: "cooldown", retryAt: "x" }), "q1", NOW),
    ).toEqual({ kind: "game_refused", reason: "cooldown", retryAt: "x" });
    expect(roundAnswerOf(refused(409, "already_completed"), "q1", NOW)).toEqual({ kind: "limit" });
    expect(roundAnswerOf({ kind: "network" }, "q1", NOW)).toEqual({ kind: "network" });
  });

  it("names the engine versions this build carries and keeps the key it is given", async () => {
    const sent: unknown[] = [];
    await startGameRound(
      {
        request: async (request) => {
          sent.push(request);
          return { kind: "network" };
        },
      },
      "q 1",
      "key-1",
    );
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/quests/q%201/game-rounds",
        body: { engineVersions: ENGINE_VERSIONS },
        headers: { "idempotency-key": "key-1" },
      },
    ]);
    expect(drawable("memory_match", 1)).toBe(true);
    expect(drawable("slide_puzzle", 2)).toBe(false);
    expect(drawable("catch", 1)).toBe(true);
    expect(drawable("tap_rush", 1)).toBe(true);
    expect(drawable("snake", 1)).toBe(false);
    expect(drawable("constructor", 1)).toBe(false);
  });
});

describe("a round's result", () => {
  it("reads every answer: paid, done, short with its target, not counted, counted as played, and retryable", () => {
    expect(resultAnswerOf(ok({ verdict: "passed", points: 40, result: {} }))).toMatchObject({
      kind: "passed",
      points: 40,
      levelUp: null,
      bonus: null,
      item: null,
    });
    expect(resultAnswerOf(ok({ verdict: "done" }))).toEqual({ kind: "done" });
    expect(
      resultAnswerOf(
        ok({
          verdict: "short",
          result: { pairs: 3 },
          target: { game: "memory_match" },
          attemptsLeft: 1,
        }),
      ),
    ).toMatchObject({ kind: "short", attemptsLeft: 1 });
    expect(resultAnswerOf(ok({ verdict: "short" }))).toEqual({ kind: "failed" });
    expect(resultAnswerOf(ok({ verdict: "new" }))).toEqual({ kind: "failed" });
    expect(resultAnswerOf(refused(422, "game_refused", { reason: "impossible" }))).toEqual({
      kind: "refused",
    });
    expect(resultAnswerOf(refused(409, "game_refused", { reason: "expired" }))).toEqual({
      kind: "expired",
    });
    expect(resultAnswerOf(refused(503, "busy"))).toEqual({ kind: "network" });
    expect(resultAnswerOf(refused(404, "not_found"))).toEqual({ kind: "failed" });
    expect(resultAnswerOf({ kind: "network" })).toEqual({ kind: "network" });
    expect(resultAnswerOf({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
    expect(resendable({ kind: "network" })).toBe(true);
    expect(resendable({ kind: "refused" })).toBe(false);
  });

  it("sends the inputs and the claim with the round's own key", async () => {
    const sent: unknown[] = [];
    await sendGameResult(
      {
        request: async (request) => {
          sent.push(request);
          return ok({ verdict: "done" });
        },
      },
      PENDING,
    );
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/game-rounds/7/result",
        body: { inputs: PENDING.inputs, claimed: PENDING.claimed },
        headers: { "idempotency-key": "k1" },
      },
    ]);
  });

  it("puts every result in words, a short one beside its target", () => {
    const en = tIn("en");
    expect(
      resultLine(
        en,
        {
          kind: "passed",
          result: {},
          points: 40,
          levelUp: null,
          bonus: null,
          item: null,
          boost: null,
          firstBonus: null,
        },
        DEFAULT_TERMS,
        "en",
      ),
    ).toContain("40");
    expect(resultLine(en, { kind: "done" }, DEFAULT_TERMS, "en")).toBe(
      "Passed. This quest was already complete.",
    );
    expect(
      resultLine(
        en,
        {
          kind: "short",
          result: { pairs: 8, moves: 24 },
          target: { game: "memory_match", pairs: 8, maxMoves: 20 },
          attemptsLeft: 0,
        },
        DEFAULT_TERMS,
        "en",
      ),
    ).toBe(
      "So close. You found 8 of 8 pairs in 24 moves. Target: Find all 8 pairs in 20 moves or fewer.",
    );
    expect(
      resultLine(
        tIn("ar"),
        {
          kind: "short",
          result: { moves: 31 },
          target: { game: "slide_puzzle", seconds: 180 },
          attemptsLeft: 1,
        },
        DEFAULT_TERMS,
        "ar",
      ),
    ).toBe("اقتربت! حرّكت القطع 31 مرة ولم تكتمل الصورة. المطلوب: أعد ترتيب الصورة خلال 180 ثانية.");
    expect(
      resultLine(
        en,
        short({ caught: 17 }, { game: "catch", caught: 20, items: 30 }),
        DEFAULT_TERMS,
        "en",
      ),
    ).toBe("So close. You needed 20; you caught 17.");
    expect(
      resultLine(
        tIn("ar"),
        short({ caught: 17 }, { game: "catch", caught: 20, items: 30 }),
        DEFAULT_TERMS,
        "ar",
      ),
    ).toBe("اقتربت! المطلوب 20 والتقطت 17.");
    expect(
      resultLine(
        en,
        short({ score: 25 }, { game: "tap_rush", score: 28, seconds: 30 }),
        DEFAULT_TERMS,
        "en",
      ),
    ).toBe("So close. You needed 28; you scored 25.");
    expect(
      resultLine(
        tIn("ar"),
        short({ score: 25 }, { game: "tap_rush", score: 28, seconds: 30 }),
        DEFAULT_TERMS,
        "ar",
      ),
    ).toBe("اقتربت! المطلوب 28 وجمعت 25.");
    expect(resultLine(en, { kind: "refused" }, DEFAULT_TERMS, "en")).toBe(
      "This round couldn't be counted.",
    );
    expect(resultLine(en, { kind: "expired" }, DEFAULT_TERMS, "en")).toBe(
      "This round counted as played.",
    );
    expect(resultLine(en, { kind: "network" }, DEFAULT_TERMS, "en")).toBe(
      "Couldn't send your result.",
    );
  });
});

describe("the result window", () => {
  it("is read on the server's clock, so a phone clock running behind does not stretch it", () => {
    expect(windowOpen(PENDING, Date.parse("2030-01-01T10:11:59Z"))).toBe(true);
    expect(windowOpen(PENDING, Date.parse("2030-01-01T10:12:00Z"))).toBe(false);
    expect(windowOpen({ ...PENDING, offsetMs: 60_000 }, Date.parse("2030-01-01T10:11:00Z"))).toBe(
      false,
    );
  });

  it("keeps a result in memory until it is sent or its window ends", () => {
    const memory = gameMemory();
    memory.keepResult(PENDING);
    expect(memory.result("q1", Date.parse("2030-01-01T10:05:00Z"))).toBe(PENDING);
    expect(memory.result("q2", Date.parse("2030-01-01T10:05:00Z"))).toBeUndefined();
    expect(memory.result("q1", Date.parse("2030-01-01T10:12:00Z"))).toBeUndefined();
    expect(memory.result("q1", Date.parse("2030-01-01T10:05:00Z"))).toBeUndefined();
    memory.keepResult(PENDING);
    memory.dropResult("q1");
    expect(memory.result("q1", NOW)).toBeUndefined();
    memory.keepRound({
      ...PENDING,
      game: "memory_match",
      level: "easy",
      seed: 1,
      params: {},
      engineVersion: 1,
    });
    expect(memory.round("7")?.seed).toBe(1);
    expect(memory.round("8")).toBeUndefined();
  });
});

describe("the board's gate", () => {
  it("drops every tap the replay would refuse, so the recorded round always replays to the app's own result", () => {
    const params = LEVELS.memory_match.easy;
    let state = memoryMatchV1.start(5, params);
    const recorded: { t: number; card: number }[] = [];
    // Two taps at once, a tap on the same card, a card that is not there, a flip during the mismatch pause.
    for (const input of [
      { t: 0, card: 0 },
      { t: 50, card: 1 },
      { t: 200, card: 0 },
      { t: 300, card: 99 },
      { t: 400, card: 1 },
      { t: 600, card: 2 },
      { t: 900, card: 3 },
    ]) {
      const gated = gateTap(memoryMatchV1, state, input);
      if (gated.accepted) {
        recorded.push(input);
      }
      state = gated.state;
    }
    expect(recorded[0]).toEqual({ t: 0, card: 0 });
    expect(recorded).not.toContainEqual({ t: 50, card: 1 });
    expect(recorded).not.toContainEqual({ t: 300, card: 99 });
    expect(replay(memoryMatchV1, 5, params, recorded)).toEqual({
      result: memoryMatchV1.resultOf(state),
    });
    const slide = slidePuzzleV1.start(5, LEVELS.slide_puzzle.easy);
    expect(gateTap(slidePuzzleV1, slide, { t: 0, tile: 0 })).toEqual({
      accepted: false,
      state: slide,
    });
  });

  it("shows a card's face when found, open, or part of a mismatch on show", () => {
    const state = { matched: [true, false, false, false], open: 2 };
    expect(faceUp(state, 0, null)).toBe(true);
    expect(faceUp(state, 1, null)).toBe(false);
    expect(faceUp(state, 2, null)).toBe(true);
    expect(faceUp(state, 3, [1, 3])).toBe(true);
    expect(faceUp(state, 1, [2, 3])).toBe(false);
  });

  it("counts the round's seconds down to 0 and never below", () => {
    expect(secondsLeftOf(120, 0)).toBe(120);
    expect(secondsLeftOf(120, 999)).toBe(120);
    expect(secondsLeftOf(120, 1000)).toBe(119);
    expect(secondsLeftOf(120, 120_000)).toBe(0);
    expect(secondsLeftOf(120, 200_000)).toBe(0);
  });
});
