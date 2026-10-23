import { describe, expect, it } from "vitest";
import { GAME_LEVELS, GAME_NAMES, LEVELS, isGameLevel, isGameName } from "#src/games/levels";
import { memoryMatchV1 } from "#src/games/memory-match/v1";
import { ENGINE_VERSIONS, gameTarget, hasEngine, judgeRound } from "#src/games/registry";
import { slidePuzzleV1 } from "#src/games/slide-puzzle/v1";

describe("the game registry", () => {
  it("names the games and levels this build plays", () => {
    expect(GAME_NAMES).toEqual(["memory_match", "slide_puzzle"]);
    expect(isGameName("memory_match")).toBe(true);
    expect(isGameName("catch")).toBe(false);
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
    }
  });

  it("states the engine version each game is drawn with", () => {
    expect(ENGINE_VERSIONS).toEqual({ memory_match: 1, slide_puzzle: 1 });
    expect(hasEngine("memory_match", 1)).toBe(true);
    expect(hasEngine("slide_puzzle", 2)).toBe(false);
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
    expect(() => gameTarget("slide_puzzle", {})).toThrow();
  });
});
