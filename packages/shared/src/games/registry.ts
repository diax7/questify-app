import { type Judgement, judge } from "#src/games/engine";
import type { GameName } from "#src/games/levels";
import { memoryMatchV1 } from "#src/games/memory-match/v1";
import { slidePuzzleV1 } from "#src/games/slide-puzzle/v1";

/**
 * Every engine version the server can still replay, by game (ADR-212). A round is replayed with the version frozen
 * on it, so an older version stays here until no open round can use it (at most the longest result window after the
 * deploy that replaced it). A deploy carrying a new version goes out before the app release that uses it.
 */
const JUDGES: Record<GameName, Record<number, (round: Round, body: Body) => Judgement>> = {
  memory_match: { 1: (round, body) => judge(memoryMatchV1, round, body) },
  slide_puzzle: { 1: (round, body) => judge(slidePuzzleV1, round, body) },
};

/** The engine version this build draws each game with: the app sends it at issue, the server freezes its own. */
export const ENGINE_VERSIONS: Record<GameName, number> = {
  memory_match: memoryMatchV1.engineVersion,
  slide_puzzle: slidePuzzleV1.engineVersion,
};

type Round = { seed: number; params: unknown };
type Body = { inputs: unknown; claimed: unknown };

/** Whether this build can replay the game at that engine version. */
export function hasEngine(game: GameName, engineVersion: number): boolean {
  return Object.hasOwn(JUDGES[game], engineVersion);
}

/** Judges a round with the engine version frozen on it; throws when this build no longer has that version. */
export function judgeRound(
  game: GameName,
  engineVersion: number,
  round: Round,
  body: Body,
): Judgement {
  const judgeWith = JUDGES[game][engineVersion];
  if (judgeWith === undefined) {
    throw new Error(`No ${game} engine version ${engineVersion} to replay this round with`);
  }
  return judgeWith(round, body);
}

/** What a level asks for, in numbers the app puts in words (FR-1806): memory's pairs and most moves, or the seconds. */
export type GameTarget =
  | Readonly<{ game: "memory_match"; pairs: number; maxMoves: number | null }>
  | Readonly<{ game: "slide_puzzle"; seconds: number }>;

/** A level's pass target from a round's frozen numbers. */
export function gameTarget(game: GameName, params: unknown): GameTarget {
  if (game === "memory_match") {
    const level = memoryMatchV1.params.parse(params);
    return { game, pairs: level.pairs, maxMoves: level.maxMoves };
  }
  return { game, seconds: slidePuzzleV1.params.parse(params).timeLimitSeconds };
}
