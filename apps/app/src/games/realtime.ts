import {
  BOARD_UNITS,
  catchV1,
  endTickOf,
  tickAt,
  type CatchInput,
  type CatchParams,
  type CatchState,
  type TapRushState,
} from "@questify/shared";

/**
 * The real-time games' game clock (ADR-216, CTO 1): milliseconds since the board showed, less the time the round was
 * paused. While paused it stands still, so the game never relies on time passing while the app is away, and phone time
 * only ever runs behind the server's (its clock check refuses only phone time ahead of it).
 */
export type GameClock = Readonly<{ shownAt: number; pausedMs: number; pausedAt: number | null }>;

export const startClock = (now: number): GameClock => ({
  shownAt: now,
  pausedMs: 0,
  pausedAt: null,
});

export const pauseClock = (clock: GameClock, now: number): GameClock =>
  clock.pausedAt === null ? { ...clock, pausedAt: now } : clock;

export const resumeClock = (clock: GameClock, now: number): GameClock =>
  clock.pausedAt === null
    ? clock
    : { ...clock, pausedMs: clock.pausedMs + (now - clock.pausedAt), pausedAt: null };

/** Whole milliseconds of play: `(now − shownAt) − pausedMs`, frozen while paused. */
export const gameTime = (clock: GameClock, now: number): number =>
  Math.floor((clock.pausedAt ?? now) - clock.shownAt - clock.pausedMs);

/** How long the board stays covered counting 3-2-1 after the player comes back. */
export const RESUME_COUNT_MS = 3000;
/** What a round keeps in hand, past its own time left, to send its result inside the window. */
export const SEND_MARGIN_MS = 30_000;

/**
 * A real-time round's pause (CTO 1): covered while the app is not active, then a 3-2-1 count that keeps the board
 * covered and the clock stopped until it ends. `ended` means the round must finish now.
 */
export type Pause = Readonly<{
  clock: GameClock;
  cover: "none" | "paused" | "counting";
  countEndsAt: number | null;
  ended: boolean;
}>;

export const startPause = (now: number): Pause => ({
  clock: startClock(now),
  cover: "none",
  countEndsAt: null,
  ended: false,
});

/** The app left the foreground: the clock stops and the board is covered. */
export function leave(pause: Pause, now: number): Pause {
  return pause.ended
    ? pause
    : { ...pause, clock: pauseClock(pause.clock, now), cover: "paused", countEndsAt: null };
}

/** Whether a round coming back must end at once: less of the result window left than its time left plus 30 s. */
export const endsOnReturn = (windowLeftMs: number, gameLeftMs: number): boolean =>
  windowLeftMs < gameLeftMs + SEND_MARGIN_MS;

/** The app came back: the round ends if the window is too short for the rest of it, else the 3-2-1 count starts. */
export function comeBack(pause: Pause, now: number, windowLeftMs: number, limitMs: number): Pause {
  if (pause.cover !== "paused") {
    return pause;
  }
  const gameLeftMs = Math.max(0, limitMs - gameTime(pause.clock, now));
  return endsOnReturn(windowLeftMs, gameLeftMs)
    ? { ...pause, cover: "none", ended: true }
    : { ...pause, cover: "counting", countEndsAt: now + RESUME_COUNT_MS };
}

/** Uncovers the board once the count has run; the counted seconds stay out of the game clock. */
export function settle(pause: Pause, now: number): Pause {
  return pause.cover === "counting" && pause.countEndsAt !== null && now >= pause.countEndsAt
    ? { ...pause, clock: resumeClock(pause.clock, now), cover: "none", countEndsAt: null }
    : pause;
}

/** Whole seconds still to count on the cover. */
export const countLeft = (pause: Pause, now: number): number =>
  pause.countEndsAt === null ? 0 : Math.max(1, Math.ceil((pause.countEndsAt - now) / 1000));

/** A finger's x on the field, in board units (ADR-216): the only number the replay ever sees. */
export function toBoardUnits(px: number, width: number): number {
  if (!(width > 0)) {
    return BOARD_UNITS / 2;
  }
  return Math.max(0, Math.min(BOARD_UNITS, Math.round((px * BOARD_UNITS) / width)));
}

/** A catch round as the app plays it: the engine's state, the recorded inputs and a target still to send. */
export type CatchLoop = Readonly<{
  state: CatchState;
  inputs: readonly CatchInput[];
  /** The newest finger x the gate could not take this tick; recorded on the next one. */
  pending: number | null;
  ended: boolean;
}>;

export const startCatch = (seed: number, params: CatchParams): CatchLoop => ({
  state: catchV1.start(seed, params),
  inputs: [],
  pending: null,
  ended: false,
});

/**
 * One frame of catch (ADR-216): the clock was read once (`t`), then (1) the finger's x, or the one still pending, is
 * recorded through the replay's own gate when it differs from the basket's target, (2) the world advances to the
 * frame's tick, (3) the screen draws. Recording before advancing keeps every input's tick at or past the state's, so
 * the app's state after any frame is the replay's state at that tick. The round ends on its last tick.
 */
export function frame(loop: CatchLoop, t: number, finger: number | null): CatchLoop {
  if (loop.ended) {
    return loop;
  }
  let { state, inputs } = loop;
  let pending: number | null = null;
  const wanted = finger ?? loop.pending;
  if (wanted !== null && wanted !== state.target) {
    const input = { t, x: wanted };
    const refused = catchV1.refusal(state, input);
    if (refused === null) {
      state = catchV1.apply(state, input);
      inputs = [...inputs, input];
    } else if (refused === "too_fast") {
      pending = wanted;
    }
  }
  const end = endTickOf(state.params.timeLimitSeconds);
  return {
    state: catchV1.advance(state, Math.min(tickAt(t), end)),
    inputs,
    pending,
    ended: tickAt(t) >= end,
  };
}

/** The tap-rush targets on the board at `tick`, by index into the schedule: up, and not yet hit. */
export function liveTargets(state: TapRushState, tick: number): number[] {
  const live: number[] = [];
  state.targets.forEach((target, index) => {
    if (target.spawn <= tick && tick < target.spawn + state.params.lifeTicks && !state.hit[index]) {
      live.push(index);
    }
  });
  return live;
}

/** The catch items falling at the state's tick, by index: spawned and not yet landed. */
export function fallingItems(state: CatchState): number[] {
  const falling: number[] = [];
  for (let index = state.next; index < state.items.length; index += 1) {
    if ((state.items[index]?.spawn ?? Infinity) > state.tick) {
      break;
    }
    falling.push(index);
  }
  return falling;
}
