import { describe, expect, it } from "vitest";
import { catchV1 } from "#src/games/catch/v1";
import { GAME_LEVELS, GAME_NAMES, LEVELS, isGameLevel, isGameName } from "#src/games/levels";
import { memoryMatchV1 } from "#src/games/memory-match/v1";
import { ENGINE_VERSIONS, gameTarget, hasEngine, judgeRound } from "#src/games/registry";
import { slidePuzzleV1 } from "#src/games/slide-puzzle/v1";
import { tapRushV1 } from "#src/games/tap-rush/v1";

describe("the game registry", () => {
  it("names the games and levels this build plays", () => {
    expect(GAME_NAMES).toEqual(["memory_match", "slide_puzzle", "catch", "tap_rush"]);
    expect(isGameName("memory_match")).toBe(true);
    expect(isGameName("tap_rush")).toBe(true);
    expect(isGameName("snake")).toBe(false);
    expect(isGameName(1)).toBe(false);
    expect(isGameLevel("hard")).toBe(true);
    expect(isGameLevel("expert")).toBe(false);
    expect(isGameLevel(undefined)).toBe(false);
  });

  it("holds levels every engine accepts", () => {
    for (const level of GAME_LEVELS) {
      expect(memoryMatchV1.params.parse(LEVELS.memory_match[level])).toEqual(
        LEVELS.memory_match[level],
      );
      expect(slidePuzzleV1.params.parse(LEVELS.slide_puzzle[level])).toEqual(
        LEVELS.slide_puzzle[level],
      );
      expect(catchV1.params.parse(LEVELS.catch[level])).toEqual(LEVELS.catch[level]);
      expect(tapRushV1.params.parse(LEVELS.tap_rush[level])).toEqual(LEVELS.tap_rush[level]);
    }
  });

  it("states the engine version each game is drawn with", () => {
    expect(ENGINE_VERSIONS).toEqual({ memory_match: 1, slide_puzzle: 1, catch: 1, tap_rush: 1 });
    expect(hasEngine("memory_match", 1)).toBe(true);
    expect(hasEngine("catch", 1)).toBe(true);
    expect(hasEngine("tap_rush", 1)).toBe(true);
    expect(hasEngine("slide_puzzle", 2)).toBe(false);
    expect(hasEngine("catch", 2)).toBe(false);
  });

  it("judges a round with the engine version frozen on it, and refuses a version it no longer has", () => {
    const round = { seed: 4, params: LEVELS.slide_puzzle.easy };
    const body = { inputs: [], claimed: { solved: false, moves: 0, ms: 0 } };
    expect(judgeRound("slide_puzzle", 1, round, body)).toEqual({
      verdict: "short",
      result: { solved: false, moves: 0, ms: 0 },
      unlikely: false,
    });
    expect(
      judgeRound("memory_match", 1, { seed: 4, params: LEVELS.memory_match.easy }, body),
    ).toEqual({ verdict: "refused", reason: "malformed" });
    expect(() => judgeRound("slide_puzzle", 9, round, body)).toThrow(/version 9/);
    const still = catchV1.resultOf(catchV1.start(4, LEVELS.catch.easy));
    expect(
      judgeRound(
        "catch",
        1,
        { seed: 4, params: LEVELS.catch.easy },
        { inputs: [], claimed: still },
      ),
    ).toEqual({ verdict: "short", result: still, unlikely: false });
    expect(
      judgeRound(
        "tap_rush",
        1,
        { seed: 4, params: LEVELS.tap_rush.easy },
        { inputs: [], claimed: { hits: 0, misses: 0, score: 0, quick: 0 } },
      ),
    ).toEqual({
      verdict: "short",
      result: { hits: 0, misses: 0, score: 0, quick: 0 },
      unlikely: false,
    });
  });

  it("states a level's pass target from its numbers", () => {
    expect(gameTarget("memory_match", LEVELS.memory_match.easy)).toEqual({
      game: "memory_match",
      pairs: 6,
      maxMoves: null,
    });
    expect(gameTarget("memory_match", LEVELS.memory_match.hard)).toEqual({
      game: "memory_match",
      pairs: 10,
      maxMoves: 22,
    });
    expect(gameTarget("slide_puzzle", LEVELS.slide_puzzle.hard)).toEqual({
      game: "slide_puzzle",
      seconds: 300,
    });
    expect(gameTarget("catch", LEVELS.catch.medium)).toEqual({
      game: "catch",
      caught: 30,
      items: 40,
    });
    expect(gameTarget("tap_rush", LEVELS.tap_rush.hard)).toEqual({
      game: "tap_rush",
      score: 34,
      seconds: 30,
    });
    expect(() => gameTarget("slide_puzzle", {})).toThrow();
    expect(() => gameTarget("catch", {})).toThrow();
    expect(() => gameTarget("tap_rush", LEVELS.catch.easy)).toThrow();
  });
});
