import { z } from "zod";
import { type GameEngine, type ImpossibleReason, timeRefusal } from "#src/games/engine";
import { type Prng, prng } from "#src/games/prng";

/** A slide-puzzle level (ADR-215): the board's side, the shuffle's length in steps and the time limit. */
export type SlideParams = { size: number; walk: number; timeLimitSeconds: number };

/** One tap: the number of the tile slid into the gap (1 to size² − 1). */
export type SlideInput = { t: number; tile: number };

export type SlideResult = { solved: boolean; moves: number; ms: number };

export type SlideState = {
  readonly params: SlideParams;
  /** The tile at each position, row by row from the top left; 0 is the gap. Solved is 1, 2, …, size² − 1, 0. */
  readonly board: readonly number[];
  readonly gap: number;
  /** Which of the default pictures the tiles show. */
  readonly picture: number;
  readonly lastT: number | null;
  readonly moves: number;
  readonly solved: boolean;
};

/** The most moves a round may hold. */
export const SLIDE_MOVE_CAP = 1000;
/** The default pictures a puzzle may show (ADR-215). */
export const SLIDE_PICTURES = 3;
/** A solve faster than this average gap per move, in fewer moves than the shuffle, is unlikely (Q-178). */
export const SLIDE_UNLIKELY_GAP_MS = 300;

const count = z.number().int().nonnegative();

const params = z.strictObject({
  size: z.number().int().min(3).max(5),
  walk: z.number().int().min(2).max(500),
  timeLimitSeconds: z.number().int().min(10).max(600),
});

function solvedBoard(size: number): number[] {
  const cells = size * size;
  return Array.from({ length: cells }, (_, position) => (position + 1) % cells);
}

function isSolved(board: readonly number[]): boolean {
  return board.every((tile, position) => tile === (position + 1) % board.length);
}

/** The positions next to `position` (up, down, left, right) on a size × size board. */
export function neighbours(position: number, size: number): number[] {
  const row = Math.trunc(position / size);
  const column = position % size;
  const around: number[] = [];
  if (row > 0) around.push(position - size);
  if (row < size - 1) around.push(position + size);
  if (column > 0) around.push(position - 1);
  if (column < size - 1) around.push(position + 1);
  return around;
}

/** Walks the gap `steps` times from the solved board, never straight back; returns the gap's positions in order. */
function walk(board: number[], size: number, steps: number, random: Prng): number[] {
  const path = [board.length - 1];
  let previous = -1;
  for (let step = 0; step < steps; step += 1) {
    const gap = path[path.length - 1] as number;
    const choices = neighbours(gap, size).filter((position) => position !== previous);
    const next = choices[random.below(choices.length)] as number;
    board[gap] = board[next] as number;
    board[next] = 0;
    previous = gap;
    path.push(next);
  }
  return path;
}

/**
 * The board a seed shuffles to, and the gap's path from the solved board (re-walked from solved while a walk lands
 * solved, so the puzzle never starts solved).
 */
export function shuffled(seed: number, level: SlideParams): { board: number[]; path: number[] } {
  const random = prng(seed);
  const board = solvedBoard(level.size);
  let path = walk(board, level.size, level.walk, random);
  while (isSolved(board)) {
    path = walk(board, level.size, level.walk, random);
  }
  return { board, path };
}

function refusal(state: SlideState, input: SlideInput): ImpossibleReason | null {
  if (state.moves >= SLIDE_MOVE_CAP) {
    return "cap";
  }
  const timing = timeRefusal(state.lastT, input.t, state.params.timeLimitSeconds);
  if (timing !== null) {
    return timing;
  }
  const position = state.board.indexOf(input.tile);
  const playable =
    !state.solved &&
    input.tile > 0 &&
    position >= 0 &&
    neighbours(state.gap, state.params.size).includes(position);
  return playable ? null : "illegal";
}

function apply(state: SlideState, input: SlideInput): SlideState {
  const board = [...state.board];
  const position = board.indexOf(input.tile);
  board[state.gap] = input.tile;
  board[position] = 0;
  return {
    ...state,
    board,
    gap: position,
    lastT: input.t,
    moves: state.moves + 1,
    solved: isSolved(board),
  };
}

/** Slide puzzle, engine version 1 (T-305, ADR-215). */
export const slidePuzzleV1: GameEngine<SlideParams, SlideState, SlideInput, SlideResult> = {
  engineVersion: 1,
  params,
  inputs: z.array(z.strictObject({ t: count, tile: count })).max(SLIDE_MOVE_CAP * 2),
  result: z.strictObject({ solved: z.boolean(), moves: count, ms: count }),
  start(seed, level) {
    const { board, path } = shuffled(seed, level);
    return {
      params: level,
      board,
      gap: path[path.length - 1] as number,
      picture: (seed >>> 0) % SLIDE_PICTURES,
      lastT: null,
      moves: 0,
      solved: false,
    };
  },
  refusal,
  apply,
  resultOf: (state) => ({ solved: state.solved, moves: state.moves, ms: state.lastT ?? 0 }),
  passes: (result) => result.solved,
  unlikely: (result, level) =>
    result.solved && result.moves < level.walk && result.ms < SLIDE_UNLIKELY_GAP_MS * result.moves,
};
