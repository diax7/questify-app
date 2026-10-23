import type { MemoryParams } from "#src/games/memory-match/v1";
import type { SlideParams } from "#src/games/slide-puzzle/v1";

/** The games the reviewed app plays (T-305). T-305c adds catch and tap rush (ADR-214). */
export const GAME_NAMES = ["memory_match", "slide_puzzle"] as const;
export type GameName = (typeof GAME_NAMES)[number];

/** Games named in FR-1804 that this version cannot play yet: the builder answers "not available" (ADR-214). */
export const COMING_GAMES = ["catch", "tap_rush"] as const;

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
};

export function isGameName(value: unknown): value is GameName {
  return typeof value === "string" && (GAME_NAMES as readonly string[]).includes(value);
}

export function isGameLevel(value: unknown): value is GameLevel {
  return typeof value === "string" && (GAME_LEVELS as readonly string[]).includes(value);
}
