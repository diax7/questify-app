import {
  type CatchInput,
  type CatchItem,
  type CatchParams,
  catchV1,
  dropsOf,
} from "#src/games/catch/v1";
import { canInput, type GameEngine } from "#src/games/engine";
import type { Prng } from "#src/games/prng";
import {
  scheduleOf,
  type TapRushInput,
  type TapRushParams,
  tapRushV1,
} from "#src/games/tap-rush/v1";
import { endTickOf, tickAt, tickStartMs } from "#src/games/ticks";

// Player models for the real-time games' tests and calibration (tests only, never bundled into a screen).

/** Keeps only the inputs the app's gate takes, in time order: what an honest app records. */
export function gated<P, S, I extends { t: number }, R>(
  engine: GameEngine<P, S, I, R>,
  seed: number,
  level: P,
  wanted: readonly I[],
): I[] {
  let state = engine.start(seed, level);
  const kept: I[] = [];
  for (const input of [...wanted].sort((left, right) => left.t - right.t)) {
    if (canInput(engine, state, input)) {
      state = engine.apply(state, input);
      kept.push(input);
    }
  }
  return kept;
}

/** The lowest item on the board after tick `tick` (shown from `seen` ticks after its spawn), if any. */
function lowest(items: readonly CatchItem[], level: CatchParams, tick: number, seen: number) {
  return items.find((item) => item.spawn + seen <= tick && item.spawn + level.fallTicks > tick);
}

/** Sends the target only when it changes, at most once a tick, as the app does; undefined keeps it where it is. */
function targetsOf(
  seed: number,
  level: CatchParams,
  wanted: (tick: number) => number | undefined,
): CatchInput[] {
  const inputs: CatchInput[] = [];
  let last = 500;
  for (let tick = 0; tick <= endTickOf(level.timeLimitSeconds); tick += 1) {
    const x = Math.max(0, Math.min(1000, wanted(tick) ?? last));
    if (x !== last) {
      inputs.push({ t: tickStartMs(tick), x });
      last = x;
    }
  }
  return gated(catchV1, seed, level, inputs);
}

/** Knows the seed: goes to each next item the tick the one before lands, so it catches every item. */
export function perfectCatch(seed: number, level: CatchParams): CatchInput[] {
  const items = dropsOf(seed, level);
  return targetsOf(seed, level, (tick) => lowest(items, level, tick, -Infinity)?.x);
}

/** Reads the seed: flicks the target onto each item the tick it spawns, then back to the item landing next. */
export function seedReaderCatch(seed: number, level: CatchParams): CatchInput[] {
  const items = dropsOf(seed, level);
  return targetsOf(
    seed,
    level,
    (tick) => (items.find((item) => item.spawn === tick) ?? lowest(items, level, tick, 0))?.x,
  );
}

/**
 * An honest player: watches the lowest item on screen, and 200 to 400 ms after it changes drags the finger there over
 * 100 to 300 ms, landing up to a quarter of the basket off; every tick of the drag moves the target.
 */
export function honestCatch(seed: number, level: CatchParams, random: Prng): CatchInput[] {
  const items = dropsOf(seed, level);
  let finger = 500;
  let from = 500;
  let to = 500;
  let start = 0;
  let span = 1;
  let watching: CatchItem | undefined;
  return targetsOf(seed, level, (tick) => {
    const now = lowest(items, level, tick, 1);
    if (now !== undefined && now !== watching) {
      watching = now;
      from = finger;
      const quarter = Math.trunc(level.basketHalf / 4);
      to = now.x - quarter + random.below(2 * quarter + 1);
      start = tick + tickAt(200 + random.below(201));
      span = tickAt(100 + random.below(201));
    }
    if (tick >= start) {
      const done = Math.min(span, tick - start);
      finger = from + Math.trunc(((to - from) * done) / span);
    }
    return finger;
  });
}

/** Knows the seed: taps each target 300 ms after it appears. */
export function perfectTapRush(seed: number, level: TapRushParams): TapRushInput[] {
  return scheduleOf(seed, level).map((target) => ({
    t: tickStartMs(target.spawn) + 300,
    cell: target.cell,
  }));
}

/** Reads the seed: taps each target 130 ms after it appears. */
export function seedReaderTapRush(seed: number, level: TapRushParams): TapRushInput[] {
  return gated(
    tapRushV1,
    seed,
    level,
    scheduleOf(seed, level).map((target) => ({
      t: tickStartMs(target.spawn) + 130,
      cell: target.cell,
    })),
  );
}

/**
 * An honest player: sees a target on the next frame and taps it 230 to 730 ms later, about 1 in 20 reactions from the
 * fast tail of 150 to 230 ms; about 1 in 20 taps lands on a wrong cell.
 */
export function honestTapRush(seed: number, level: TapRushParams, random: Prng): TapRushInput[] {
  const cells = level.columns * level.rows;
  const taps = scheduleOf(seed, level).map((target) => {
    const reaction = random.below(20) === 0 ? 150 + random.below(81) : 230 + random.below(501);
    const cell = random.below(20) === 0 ? random.below(cells) : target.cell;
    return { t: tickStartMs(target.spawn + 1) + reaction, cell };
  });
  return gated(tapRushV1, seed, level, taps);
}
