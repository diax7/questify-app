import { z } from "zod";
import { type GameEngine, type ImpossibleReason, timeRefusal } from "#src/games/engine";
import { prng } from "#src/games/prng";
import { endTickOf, tickStartMs } from "#src/games/ticks";

/** A tap-rush level (ADR-218): the round's length, the grid, each target's life and the gaps between them. */
export type TapRushParams = {
  timeLimitSeconds: number;
  columns: number;
  rows: number;
  /** Ticks a target stays up. */
  lifeTicks: number;
  gapMin: number;
  gapMax: number;
  scoreTarget: number;
  /** This many quick hits in one round is unlikely (Q-182: under 1% of honest rounds at each level). */
  unlikelyQuick: number;
};

/** A tap on a cell of the grid, numbered row by row from the top left (never mirrored). */
export type TapRushInput = { t: number; cell: number };

export type TapRushResult = { hits: number; misses: number; score: number; quick: number };

export type TapTarget = { readonly spawn: number; readonly cell: number };

export type TapRushState = {
  readonly params: TapRushParams;
  /** The seed's schedule, in spawn order. */
  readonly targets: readonly TapTarget[];
  readonly hit: readonly boolean[];
  readonly lastT: number | null;
  readonly taps: number;
  readonly hits: number;
  readonly misses: number;
  readonly quick: number;
};

/** The first target spawns half a second in. */
const FIRST_SPAWN_TICK = 15;
/** A hit on a target younger than this is impossible: under any human reaction (ADR-217). */
export const TAP_REACTION_FLOOR_MS = 120;
/** A hit on a target younger than this is quick, and enough of them unlikely (ADR-217). */
export const TAP_QUICK_MS = 200;
/** A tap this soon after a target's life ended is neither hit nor miss (ADR-217). */
export const TAP_GRACE_MS = 150;
/** The most taps a round may hold: 30 s at the 100 ms floor. */
export const TAP_CAP = 300;

const count = z.number().int().nonnegative();

const params = z
  .strictObject({
    timeLimitSeconds: z.number().int().min(10).max(60),
    columns: z.number().int().min(2).max(5),
    rows: z.number().int().min(2).max(6),
    lifeTicks: z.number().int().min(6).max(150),
    gapMin: z.number().int().min(3).max(150),
    gapMax: z.number().int().min(3).max(150),
    scoreTarget: z.number().int().min(1),
    unlikelyQuick: z.number().int().min(1),
  })
  .refine((level) => level.gapMin <= level.gapMax);

const upAt = (target: TapTarget, tick: number, life: number): boolean =>
  target.spawn <= tick && tick < target.spawn + life;

/**
 * The targets a seed shows (ADR-218): each in a cell no other target holds at its spawn, until a target could no
 * longer live out its life before the round ends.
 */
export function scheduleOf(seed: number, level: TapRushParams): TapTarget[] {
  const random = prng(seed);
  const cells = level.columns * level.rows;
  const end = endTickOf(level.timeLimitSeconds);
  const targets: TapTarget[] = [];
  for (let spawn = FIRST_SPAWN_TICK; spawn + level.lifeTicks <= end;) {
    const free: number[] = [];
    for (let cell = 0; cell < cells; cell += 1) {
      if (!targets.some((other) => other.cell === cell && upAt(other, spawn, level.lifeTicks))) {
        free.push(cell);
      }
    }
    targets.push({ spawn, cell: free[random.below(free.length)] as number });
    spawn += level.gapMin + random.below(level.gapMax - level.gapMin + 1);
  }
  return targets;
}

/** The target up and not yet hit in the input's cell at its time, or -1. */
function liveTarget(state: TapRushState, input: TapRushInput): number {
  const life = state.params.lifeTicks;
  return state.targets.findIndex(
    (target, index) =>
      target.cell === input.cell &&
      state.hit[index] === false &&
      tickStartMs(target.spawn) <= input.t &&
      input.t < tickStartMs(target.spawn + life),
  );
}

/** Whether a target in the input's cell went, not hit, under 150 ms before it. */
function inGrace(state: TapRushState, input: TapRushInput): boolean {
  return state.targets.some((target, index) => {
    const gone = input.t - tickStartMs(target.spawn + state.params.lifeTicks);
    return (
      target.cell === input.cell && state.hit[index] === false && gone >= 0 && gone < TAP_GRACE_MS
    );
  });
}

function refusal(state: TapRushState, input: TapRushInput): ImpossibleReason | null {
  if (state.taps >= TAP_CAP) {
    return "cap";
  }
  const timing = timeRefusal(state.lastT, input.t, state.params.timeLimitSeconds);
  if (timing !== null) {
    return timing;
  }
  if (input.cell >= state.params.columns * state.params.rows) {
    return "illegal";
  }
  const live = liveTarget(state, input);
  const young =
    live >= 0 &&
    input.t - tickStartMs((state.targets[live] as TapTarget).spawn) < TAP_REACTION_FLOOR_MS;
  return young ? "too_fast" : null;
}

/** A live target in the cell is hit; else a target gone under 150 ms ago leaves the tap uncounted; else a miss. */
function apply(state: TapRushState, input: TapRushInput): TapRushState {
  const tapped = { ...state, lastT: input.t, taps: state.taps + 1 };
  const live = liveTarget(state, input);
  if (live >= 0) {
    const hit = [...state.hit];
    hit[live] = true;
    const age = input.t - tickStartMs((state.targets[live] as TapTarget).spawn);
    return {
      ...tapped,
      hit,
      hits: state.hits + 1,
      quick: state.quick + (age < TAP_QUICK_MS ? 1 : 0),
    };
  }
  return inGrace(state, input) ? tapped : { ...tapped, misses: state.misses + 1 };
}

/** Tap rush, engine version 1 (T-305c, ADR-217, ADR-218). */
export const tapRushV1: GameEngine<TapRushParams, TapRushState, TapRushInput, TapRushResult> = {
  engineVersion: 1,
  params,
  inputs: z.array(z.strictObject({ t: count, cell: count })).max(TAP_CAP * 2),
  result: z.strictObject({ hits: count, misses: count, score: count, quick: count }),
  start(seed, level) {
    const targets = scheduleOf(seed, level);
    return {
      params: level,
      targets,
      hit: targets.map(() => false),
      lastT: null,
      taps: 0,
      hits: 0,
      misses: 0,
      quick: 0,
    };
  },
  refusal,
  apply,
  resultOf: (state) => ({
    hits: state.hits,
    misses: state.misses,
    score: Math.max(0, state.hits - state.misses),
    quick: state.quick,
  }),
  passes: (result, level) => result.score >= level.scoreTarget,
  unlikely: (result, level) => result.quick >= level.unlikelyQuick,
};
