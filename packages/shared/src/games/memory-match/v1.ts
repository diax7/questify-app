import { z } from "zod";
import { type GameEngine, type ImpossibleReason, timeRefusal } from "#src/games/engine";
import { prng, shuffle } from "#src/games/prng";

/** A memory-match level (ADR-215): the pairs, the grid that holds them, the time limit and the most moves to pass. */
export type MemoryParams = {
  pairs: number;
  columns: number;
  rows: number;
  timeLimitSeconds: number;
  /** The most moves a pass may take; null when finding every pair is enough. */
  maxMoves: number | null;
  /** This many lucky matches in one round is unlikely (Q-178: under 1% of honest rounds at each level). */
  unlikelyLucky: number;
};

/** One flip: the card's index on the board. */
export type MemoryInput = { t: number; card: number };

export type MemoryResult = {
  pairs: number;
  moves: number;
  ms: number;
  /** Moves whose second card had never been seen and matched while 4 or more cards were still unseen. */
  lucky: number;
};

export type MemoryState = {
  readonly params: MemoryParams;
  /** The picture on each card: every picture index from 0 to pairs − 1 twice, in the seed's order. */
  readonly deck: readonly number[];
  readonly matched: readonly boolean[];
  readonly seen: readonly boolean[];
  /** The first card of the move under way, face up; null between moves. */
  readonly open: number | null;
  /** After a mismatch both cards show until this time and no card can be flipped. */
  readonly pauseUntil: number;
  readonly lastT: number | null;
  readonly flips: number;
  readonly moves: number;
  readonly found: number;
  readonly lucky: number;
};

/** How long a mismatched pair shows before it turns back. */
export const MISMATCH_MS = 700;
/** The most flips a round may hold. */
export const MEMORY_FLIP_CAP = 400;
/** A lucky match counts only while at least this many cards were unseen. */
const LUCKY_UNSEEN = 4;

const count = z.number().int().nonnegative();

const params = z.strictObject({
  pairs: z.number().int().min(2).max(10),
  columns: z.number().int().min(2).max(6),
  rows: z.number().int().min(2).max(6),
  timeLimitSeconds: z.number().int().min(10).max(600),
  maxMoves: z.number().int().positive().nullable(),
  unlikelyLucky: z.number().int().min(1).max(10),
});

function refusal(state: MemoryState, input: MemoryInput): ImpossibleReason | null {
  if (state.flips >= MEMORY_FLIP_CAP) {
    return "cap";
  }
  const timing = timeRefusal(state.lastT, input.t, state.params.timeLimitSeconds);
  if (timing !== null) {
    return timing;
  }
  const playable =
    input.card < state.deck.length &&
    state.found < state.params.pairs &&
    state.matched[input.card] === false &&
    input.card !== state.open &&
    input.t >= state.pauseUntil;
  return playable ? null : "illegal";
}

function settle(state: MemoryState, input: MemoryInput, seen: boolean[]): MemoryState {
  const first = state.open as number;
  const unseen = state.seen.filter((wasSeen) => !wasSeen).length;
  const isMatch = state.deck[first] === state.deck[input.card];
  const isLucky = isMatch && state.seen[input.card] === false && unseen >= LUCKY_UNSEEN;
  const matched = [...state.matched];
  if (isMatch) {
    matched[first] = true;
    matched[input.card] = true;
  }
  return {
    ...state,
    matched,
    seen,
    open: null,
    pauseUntil: isMatch ? state.pauseUntil : input.t + MISMATCH_MS,
    lastT: input.t,
    flips: state.flips + 1,
    moves: state.moves + 1,
    found: state.found + (isMatch ? 1 : 0),
    lucky: state.lucky + (isLucky ? 1 : 0),
  };
}

function apply(state: MemoryState, input: MemoryInput): MemoryState {
  const seen = [...state.seen];
  seen[input.card] = true;
  if (state.open === null) {
    return { ...state, seen, open: input.card, lastT: input.t, flips: state.flips + 1 };
  }
  return settle(state, input, seen);
}

/** Memory match, engine version 1 (T-305, ADR-215). */
export const memoryMatchV1: GameEngine<MemoryParams, MemoryState, MemoryInput, MemoryResult> = {
  engineVersion: 1,
  params,
  inputs: z.array(z.strictObject({ t: count, card: count })).max(MEMORY_FLIP_CAP * 2),
  result: z.strictObject({ pairs: count, moves: count, ms: count, lucky: count }),
  start(seed, level) {
    const deck: number[] = [];
    for (let picture = 0; picture < level.pairs; picture += 1) {
      deck.push(picture, picture);
    }
    shuffle(deck, prng(seed));
    const none = deck.map(() => false);
    return {
      params: level,
      deck,
      matched: none,
      seen: none,
      open: null,
      pauseUntil: 0,
      lastT: null,
      flips: 0,
      moves: 0,
      found: 0,
      lucky: 0,
    };
  },
  refusal,
  apply,
  resultOf: (state) => ({
    pairs: state.found,
    moves: state.moves,
    ms: state.lastT ?? 0,
    lucky: state.lucky,
  }),
  passes: (result, level) =>
    result.pairs === level.pairs && (level.maxMoves === null || result.moves <= level.maxMoves),
  unlikely: (result, level) => result.lucky >= level.unlikelyLucky,
};
