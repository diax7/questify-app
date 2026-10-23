import {
  catchV1,
  judge,
  tapRushV1,
  tickAt,
  type CatchParams,
  type Judgement,
  type Prng,
  type TapRushInput,
  type TapRushParams,
} from "@questify/shared";
import {
  comeBack,
  fallingItems,
  frame,
  gameTime,
  leave,
  liveTargets,
  settle,
  startCatch,
  startPause,
  toBoardUnits,
  RESUME_COUNT_MS,
  type CatchLoop,
  type Pause,
} from "#src/games/realtime.ts";
import { gateTap } from "#src/games/round.ts";

// Honest play through the app's own frame, tap handler, gate and pause (tests only, never bundled into a screen).

const WINDOW_MS = 10 * 60 * 1000;

/** How a round's frames come: gaps of 8 to 250 ms, one 2 s stall in some rounds, one long pause in others. */
type Schedule = { stallAt: number | null; pauseAt: number | null; readonly pauseMs: number };

function scheduleOf(random: Prng, limitMs: number): Schedule {
  const stall = random.below(10) === 0;
  const pause = random.below(10) === 0;
  return {
    stallAt: stall ? random.below(limitMs) : null,
    pauseAt: pause ? random.below(limitMs) : null,
    pauseMs: 1000 + random.below(5 * 60 * 1000),
  };
}

/** A round in play on the phone: device time now, the pause, and how far the server's clock has run. */
type Device = { now: number; pause: Pause; readonly issuedAt: number; readonly limitMs: number };

/**
 * Moves device time one frame on, through a stall or a pause (left, come back, counted 3-2-1) when one is due.
 * Answers whether the app was away.
 */
function nextFrame(device: Device, random: Prng, schedule: Schedule, played: number): boolean {
  device.now += 8 + random.below(243);
  if (schedule.stallAt !== null && played >= schedule.stallAt) {
    device.now += 2000;
    schedule.stallAt = null;
  }
  if (schedule.pauseAt !== null && played >= schedule.pauseAt) {
    schedule.pauseAt = null;
    device.pause = leave(device.pause, device.now);
    device.now += schedule.pauseMs;
    const windowLeft = device.issuedAt + device.limitMs + WINDOW_MS - device.now;
    device.pause = comeBack(device.pause, device.now, windowLeft, device.limitMs);
    device.now += RESUME_COUNT_MS;
    device.pause = settle(device.pause, device.now);
    return true;
  }
  return false;
}

export type Played = Readonly<{
  inputs: readonly unknown[];
  claimed: unknown;
  judged: Judgement;
  /** Whether every input's time stayed at or below the server's elapsed time. */
  behindServer: boolean;
}>;

/** The finger of an honest catch player: chases the lowest falling item after a reaction, over a short drag. */
function catchFinger(random: Prng) {
  let watching = -1;
  let from = 500;
  let to = 500;
  let startT = 0;
  let span = 1;
  let finger = 500;
  return (loop: CatchLoop, t: number): number | null => {
    const lowest = fallingItems(loop.state)[0];
    if (lowest !== undefined && lowest !== watching) {
      watching = lowest;
      from = finger;
      to = (loop.state.items[lowest]?.x ?? 500) - 30 + random.below(61);
      startT = t + 200 + random.below(201);
      span = 100 + random.below(201);
    }
    if (t < startT) {
      return random.below(8) === 0 ? null : finger;
    }
    const width = 300 + random.below(131);
    const px = ((from + ((to - from) * Math.min(span, t - startT)) / span) * width) / 1000;
    finger = toBoardUnits(px, width);
    return finger;
  };
}

/** Plays a catch round the way the app does: one clock read per frame, then `frame`. */
export function playCatch(seed: number, params: CatchParams, random: Prng): Played {
  const limitMs = params.timeLimitSeconds * 1000;
  const schedule = scheduleOf(random, limitMs);
  const device: Device = { now: 5000, pause: startPause(5000), issuedAt: 4000, limitMs };
  const finger = catchFinger(random);
  let loop = startCatch(seed, params);
  let behindServer = true;
  while (!loop.ended && !device.pause.ended) {
    nextFrame(device, random, schedule, gameTime(device.pause.clock, device.now));
    if (device.pause.ended) {
      break;
    }
    const t = gameTime(device.pause.clock, device.now);
    behindServer &&= t <= device.now - device.issuedAt;
    loop = frame(loop, t, finger(loop, t));
  }
  const claimed = catchV1.resultOf(loop.state);
  const body = { inputs: loop.inputs, claimed };
  return { ...body, judged: judge(catchV1, { seed, params }, body), behindServer };
}

/** Plays a tap-rush round the way the app does: taps stamped at the touch, through the gate, frames only draw. */
export function playTapRush(seed: number, params: TapRushParams, random: Prng): Played {
  const limitMs = params.timeLimitSeconds * 1000;
  const schedule = scheduleOf(random, limitMs);
  const device: Device = { now: 5000, pause: startPause(5000), issuedAt: 4000, limitMs };
  let state = tapRushV1.start(seed, params);
  const inputs: TapRushInput[] = [];
  const seen = new Set<number>();
  let planned: { at: number; cell: number }[] = [];
  let behindServer = true;
  for (let t = 0; t <= limitMs && !device.pause.ended;) {
    if (nextFrame(device, random, schedule, t)) {
      planned = [];
    }
    const due = planned.filter((tap) => tap.at <= device.now).sort((a, b) => a.at - b.at);
    planned = planned.filter((tap) => tap.at > device.now);
    for (const tap of due) {
      const touched = gameTime(device.pause.clock, tap.at);
      if (device.pause.cover === "none" && touched <= limitMs) {
        behindServer &&= touched <= tap.at - device.issuedAt;
        const gated = gateTap(tapRushV1, state, { t: touched, cell: tap.cell });
        state = gated.state;
        if (gated.accepted) {
          inputs.push({ t: touched, cell: tap.cell });
        }
      }
    }
    t = gameTime(device.pause.clock, device.now);
    for (const index of liveTargets(state, tickAt(t))) {
      if (!seen.has(index)) {
        seen.add(index);
        const fast = random.below(20) === 0;
        const reaction = fast ? 150 + random.below(81) : 230 + random.below(501);
        planned.push({ at: device.now + reaction, cell: state.targets[index]?.cell ?? 0 });
      }
    }
    if (random.below(12) === 0) {
      planned.push({ at: device.now + random.below(250), cell: random.below(14) });
    }
  }
  const claimed = tapRushV1.resultOf(state);
  return {
    inputs,
    claimed,
    judged: judge(tapRushV1, { seed, params }, { inputs, claimed }),
    behindServer,
  };
}
