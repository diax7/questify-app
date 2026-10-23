import type { CatchParams } from "#src/games/catch/v1";
import type { MemoryParams } from "#src/games/memory-match/v1";
import type { SlideParams } from "#src/games/slide-puzzle/v1";
import type { TapRushParams } from "#src/games/tap-rush/v1";

/** FR-1804's four games: memory match and slide puzzle (T-305), catch and tap rush (T-305c, ADR-216). */
export const GAME_NAMES = ["memory_match", "slide_puzzle", "catch", "tap_rush"] as const;
export type GameName = (typeof GAME_NAMES)[number];

export const GAME_LEVELS = ["easy", "medium", "hard"] as const;
export type GameLevel = (typeof GAME_LEVELS)[number];

/**
 * Each level's numbers (ADR-215, Q-178): Questify tuning, frozen on every round and sent with it, so retuning is a
 * server deploy and never a store release. Migration 0050's `game_level` holds the same table; a database test keeps
 * them equal.
 */
export const LEVELS: {
  memory_match: Record<GameLevel, MemoryParams>;
  slide_puzzle: Record<GameLevel, SlideParams>;
  catch: Record<GameLevel, CatchParams>;
  tap_rush: Record<GameLevel, TapRushParams>;
} = {
  memory_match: {
    easy: {
      pairs: 6,
      columns: 3,
      rows: 4,
      timeLimitSeconds: 120,
      maxMoves: null,
      unlikelyLucky: 3,
    },
    medium: {
      pairs: 8,
      columns: 4,
      rows: 4,
      timeLimitSeconds: 120,
      maxMoves: 20,
      unlikelyLucky: 4,
    },
    hard: { pairs: 10, columns: 4, rows: 5, timeLimitSeconds: 120, maxMoves: 22, unlikelyLucky: 4 },
  },
  slide_puzzle: {
    easy: { size: 3, walk: 20, timeLimitSeconds: 180 },
    medium: { size: 3, walk: 60, timeLimitSeconds: 180 },
    hard: { size: 4, walk: 120, timeLimitSeconds: 300 },
  },
  // ADR-218, Q-182: starting tuning. The unlikely counts come from the calibration tests (catch/v1.calibration.test.ts,
  // tap-rush/v1.calibration.test.ts): honest play flagged in under 1% of rounds, a seed reader in over 90%.
  catch: {
    easy: {
      timeLimitSeconds: 45,
      items: 30,
      fallTicks: 60,
      gapMin: 30,
      gapMax: 42,
      basketHalf: 100,
      basketSpeed: 40,
      catchTarget: 20,
      unlikelyForesight: 10,
    },
    medium: {
      timeLimitSeconds: 45,
      items: 40,
      fallTicks: 48,
      gapMin: 22,
      gapMax: 32,
      basketHalf: 80,
      basketSpeed: 40,
      catchTarget: 30,
      unlikelyForesight: 12,
    },
    hard: {
      timeLimitSeconds: 45,
      items: 50,
      fallTicks: 36,
      gapMin: 18,
      gapMax: 25,
      basketHalf: 65,
      basketSpeed: 45,
      catchTarget: 40,
      unlikelyForesight: 16,
    },
  },
  tap_rush: {
    easy: {
      timeLimitSeconds: 30,
      columns: 3,
      rows: 4,
      lifeTicks: 45,
      gapMin: 18,
      gapMax: 24,
      scoreTarget: 20,
      unlikelyQuick: 8,
    },
    medium: {
      timeLimitSeconds: 30,
      columns: 3,
      rows: 4,
      lifeTicks: 33,
      gapMin: 14,
      gapMax: 19,
      scoreTarget: 28,
      unlikelyQuick: 8,
    },
    hard: {
      timeLimitSeconds: 30,
      columns: 3,
      rows: 4,
      lifeTicks: 24,
      gapMin: 11,
      gapMax: 15,
      scoreTarget: 34,
      unlikelyQuick: 8,
    },
  },
};

export function isGameName(value: unknown): value is GameName {
  return typeof value === "string" && (GAME_NAMES as readonly string[]).includes(value);
}

export function isGameLevel(value: unknown): value is GameLevel {
  return typeof value === "string" && (GAME_LEVELS as readonly string[]).includes(value);
}
