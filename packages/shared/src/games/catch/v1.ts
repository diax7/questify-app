import { z } from "zod";
import type { ImpossibleReason, RealtimeEngine } from "#src/games/engine";
import { type Prng, prng } from "#src/games/prng";
import { endTickOf, tickAt } from "#src/games/ticks";

/** A catch level (ADR-218): the round's length, the falling items, the basket and the pass and unlikely counts. */
export type CatchParams = {
  timeLimitSeconds: number;
  items: number;
  /** Ticks from an item's spawn to its landing. */
  fallTicks: number;
  gapMin: number;
  gapMax: number;
  /** An item landing within this many board units of the basket's middle is caught. */
  basketHalf: number;
  /** The most board units the basket moves in one tick. */
  basketSpeed: number;
  catchTarget: number;
  /** This many foreseen catches in one round is unlikely (Q-182: under 1% of honest rounds at each level). */
  unlikelyForesight: number;
};

/** The basket's target: the finger's x in board units (0 to 1,000), sent only when it changes, at most once a tick. */
export type CatchInput = { t: number; x: number };

export type CatchResult = { caught: number; missed: number; foreseen: number };

export type CatchItem = { readonly spawn: number; readonly x: number; readonly face: number };

/** An item's foresight, decided by the first input that puts the target over it (ADR-217). */
type Sight = "open" | "foreseen" | "seen";

export type CatchState = {
  readonly params: CatchParams;
  readonly items: readonly CatchItem[];
  /** The last tick the world ran. */
  readonly tick: number;
  readonly basket: number;
  readonly target: number;
  /** The first item still to land. */
  readonly next: number;
  readonly sight: readonly Sight[];
  readonly caught: number;
  readonly missed: number;
  readonly foreseen: number;
  readonly lastT: number | null;
  readonly inputs: number;
};

/** The board's width in units (ADR-216), never mirrored. */
export const BOARD_UNITS = 1000;
/** Items land between these x values, so a whole item stays on the board. */
const ITEM_MIN_X = 50;
const ITEM_MAX_X = 950;
/** The first item spawns 1 s in. */
const FIRST_SPAWN_TICK = 30;
/** How many default faces an item may show. */
export const CATCH_FACES = 5;
/** A move onto an item within this many ticks of its spawn (under 133 ms) is foreseen (ADR-217). */
export const FORESIGHT_TICKS = 3;
/** The most inputs a round may hold: one a tick from tick 0 to the end of the longest level (45 s). */
export const CATCH_INPUT_CAP = 1351;

const count = z.number().int().nonnegative();

const params = z
  .strictObject({
    timeLimitSeconds: z.number().int().min(10).max(45),
    items: z.number().int().min(1).max(100),
    fallTicks: z.number().int().min(10).max(150),
    gapMin: z.number().int().min(5).max(150),
    gapMax: z.number().int().min(5).max(150),
    basketHalf: z.number().int().min(10).max(300),
    basketSpeed: z.number().int().min(5).max(200),
    catchTarget: z.number().int().min(1),
    unlikelyForesight: z.number().int().min(1),
  })
  .refine((level) => level.gapMin <= level.gapMax && level.catchTarget <= level.items);

/** The next item's x: inside the board and within what the basket covers in `gap` ticks of the previous one. */
function nextX(previous: number, gap: number, speed: number, random: Prng): number {
  const low = Math.max(ITEM_MIN_X, previous - speed * gap);
  const high = Math.min(ITEM_MAX_X, previous + speed * gap);
  return low + random.below(high - low + 1);
}

/** The items a seed drops (ADR-218): every one reachable from the one before by a perfect player. */
export function dropsOf(seed: number, level: CatchParams): CatchItem[] {
  const random = prng(seed);
  const items: CatchItem[] = [];
  let spawn = FIRST_SPAWN_TICK;
  let x = ITEM_MIN_X + random.below(ITEM_MAX_X - ITEM_MIN_X + 1);
  for (let index = 0; index < level.items; index += 1) {
    if (index > 0) {
      const gap = level.gapMin + random.below(level.gapMax - level.gapMin + 1);
      spawn += gap;
      x = nextX(x, gap, level.basketSpeed, random);
    }
    items.push({ spawn, x, face: random.below(CATCH_FACES) });
  }
  return items;
}

const within = (state: CatchState, x: number, item: CatchItem): boolean =>
  Math.abs(x - item.x) <= state.params.basketHalf;

/** Runs the world one tick at a time to `tick`: the basket walks toward its target, then items land. */
function advance(state: CatchState, tick: number): CatchState {
  if (tick <= state.tick) {
    return state;
  }
  const { basketSpeed, fallTicks } = state.params;
  let { basket, next, caught, missed, foreseen } = state;
  for (let at = state.tick + 1; at <= tick; at += 1) {
    basket += Math.max(-basketSpeed, Math.min(basketSpeed, state.target - basket));
    while (next < state.items.length && (state.items[next] as CatchItem).spawn + fallTicks <= at) {
      const item = state.items[next] as CatchItem;
      if (within(state, basket, item)) {
        caught += 1;
        foreseen += state.sight[next] === "foreseen" ? 1 : 0;
      } else {
        missed += 1;
      }
      next += 1;
    }
  }
  return { ...state, tick, basket, next, caught, missed, foreseen };
}

function refusal(state: CatchState, input: CatchInput): ImpossibleReason | null {
  if (state.inputs >= CATCH_INPUT_CAP) {
    return "cap";
  }
  if (state.lastT !== null && input.t < state.lastT) {
    return "order";
  }
  if (state.lastT !== null && tickAt(input.t) === tickAt(state.lastT)) {
    return "too_fast";
  }
  return input.t > state.params.timeLimitSeconds * 1000 ? "late" : null;
}

/** Decides the foresight of every falling item this input is the first to put the target over. */
function sightAfter(state: CatchState, x: number): readonly Sight[] {
  const sight = [...state.sight];
  for (let index = state.next; index < state.items.length; index += 1) {
    const item = state.items[index] as CatchItem;
    if (item.spawn > state.tick) {
      break;
    }
    if (sight[index] === "open" && within(state, x, item)) {
      const quick =
        state.tick <= item.spawn + FORESIGHT_TICKS && !within(state, state.target, item);
      sight[index] = quick ? "foreseen" : "seen";
    }
  }
  return sight;
}

function apply(state: CatchState, input: CatchInput): CatchState {
  const moved = advance(state, tickAt(input.t));
  return {
    ...moved,
    target: input.x,
    sight: sightAfter(moved, input.x),
    lastT: input.t,
    inputs: moved.inputs + 1,
  };
}

/** Catch, engine version 1 (T-305c, ADR-216 to ADR-218). */
export const catchV1: RealtimeEngine<CatchParams, CatchState, CatchInput, CatchResult> = {
  engineVersion: 1,
  params,
  inputs: z.array(z.strictObject({ t: count, x: count.max(BOARD_UNITS) })).max(CATCH_INPUT_CAP * 2),
  result: z.strictObject({ caught: count, missed: count, foreseen: count }),
  start(seed, level) {
    const items = dropsOf(seed, level);
    return {
      params: level,
      items,
      tick: 0,
      basket: BOARD_UNITS / 2,
      target: BOARD_UNITS / 2,
      next: 0,
      sight: items.map(() => "open"),
      caught: 0,
      missed: 0,
      foreseen: 0,
      lastT: null,
      inputs: 0,
    };
  },
  refusal,
  apply,
  advance,
  resultOf: (state) => {
    const end = advance(state, endTickOf(state.params.timeLimitSeconds));
    return { caught: end.caught, missed: end.missed, foreseen: end.foreseen };
  },
  passes: (result, level) => result.caught >= level.catchTarget,
  unlikely: (result, level) => result.foreseen >= level.unlikelyForesight,
};
