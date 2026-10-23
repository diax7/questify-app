import { describe, expect, it } from "vitest";
import {
  GAME_LEVELS,
  LEVELS,
  catchV1,
  prng,
  replay,
  tapRushV1,
  tickStartMs,
} from "@questify/shared";
import {
  comeBack,
  countLeft,
  endsOnReturn,
  fallingItems,
  frame,
  gameTime,
  leave,
  liveTargets,
  pauseClock,
  resumeClock,
  settle,
  startCatch,
  startClock,
  startPause,
  toBoardUnits,
  RESUME_COUNT_MS,
} from "#src/games/realtime.ts";
import { playCatch, playTapRush } from "#src/games/testing/realtime-play.ts";

const easy = LEVELS.catch.easy;

describe("the game clock", () => {
  it("counts whole milliseconds since the board showed, less the time paused, and stands still while paused", () => {
    let clock = startClock(1000.4);
    expect(gameTime(clock, 3000.9)).toBe(2000);
    clock = pauseClock(clock, 3000);
    expect(gameTime(clock, 60_000)).toBe(1999);
    expect(pauseClock(clock, 9000)).toBe(clock);
    clock = resumeClock(clock, 63_000);
    expect(gameTime(clock, 63_000)).toBe(1999);
    expect(gameTime(clock, 64_000)).toBe(2999);
    expect(resumeClock(clock, 70_000)).toBe(clock);
  });
});

describe("the pause (CTO 1)", () => {
  const limitMs = 45_000;

  it("covers the board while the app is away and takes the time away out of t", () => {
    let pause = leave(startPause(0), 10_000);
    expect(pause.cover).toBe("paused");
    pause = comeBack(pause, 70_000, 10 * 60_000, limitMs);
    expect(pause.cover).toBe("counting");
    expect(gameTime(pause.clock, 70_000)).toBe(10_000);
  });

  it("keeps the board covered through the 3-2-1 count and keeps the count's time out of t (CTO 5)", () => {
    let pause = comeBack(leave(startPause(0), 10_000), 20_000, 10 * 60_000, limitMs);
    expect(countLeft(pause, 20_000)).toBe(3);
    expect(countLeft(pause, 21_500)).toBe(2);
    expect(settle(pause, 20_000 + RESUME_COUNT_MS - 1).cover).toBe("counting");
    expect(gameTime(pause.clock, 22_999)).toBe(10_000);
    pause = settle(pause, 20_000 + RESUME_COUNT_MS);
    expect(pause.cover).toBe("none");
    expect(gameTime(pause.clock, 23_000)).toBe(10_000);
    expect(gameTime(pause.clock, 24_000)).toBe(11_000);
    expect(leave(pause, 25_000).cover).toBe("paused");
    expect(comeBack(pause, 30_000, 0, limitMs)).toBe(pause);
  });

  it("leaving again during the count covers it and stops it", () => {
    const counting = comeBack(leave(startPause(0), 10_000), 20_000, 10 * 60_000, limitMs);
    const again = leave(counting, 21_000);
    expect(again).toMatchObject({ cover: "paused", countEndsAt: null });
    expect(gameTime(again.clock, 99_000)).toBe(10_000);
  });

  it("ends the round on return when the window left is under the game time left plus 30 s (CTO note 1)", () => {
    expect(endsOnReturn(64_999, 35_000)).toBe(true);
    expect(endsOnReturn(65_000, 35_000)).toBe(false);
    const away = leave(startPause(0), 10_000);
    expect(comeBack(away, 600_000, 64_999, limitMs)).toMatchObject({ ended: true, cover: "none" });
    expect(comeBack(away, 600_000, 65_000, limitMs).cover).toBe("counting");
    expect(leave({ ...away, ended: true }, 700_000)).toEqual({ ...away, ended: true });
  });
});

describe("a finger on the field", () => {
  it("becomes whole board units from 0 to 1,000 whatever the screen", () => {
    expect(toBoardUnits(0, 360)).toBe(0);
    expect(toBoardUnits(180, 360)).toBe(500);
    expect(toBoardUnits(1, 360)).toBe(3);
    expect(toBoardUnits(400, 360)).toBe(1000);
    expect(toBoardUnits(-20, 360)).toBe(0);
    expect(toBoardUnits(10, 0)).toBe(500);
  });
});

describe("one catch frame (ADR-216)", () => {
  it("records the finger before it advances the world, so the input's tick is the state's", () => {
    const loop = frame(startCatch(1, easy), 1000, 800);
    expect(loop.inputs).toEqual([{ t: 1000, x: 800 }]);
    expect(loop.state).toMatchObject({ tick: 30, target: 800, basket: 500 });
    expect(frame(loop, 1034, null).state.basket).toBe(540);
  });

  it("records nothing while the finger stays put, or when it is lifted", () => {
    const loop = frame(startCatch(1, easy), 1000, 800);
    expect(frame(loop, 1100, 800).inputs).toHaveLength(1);
    expect(frame(loop, 1100, null).inputs).toHaveLength(1);
    expect(frame(startCatch(1, easy), 500, 500).inputs).toEqual([]);
  });

  it("records one input a tick, keeping the newest x pending for the next tick", () => {
    let loop = frame(startCatch(1, easy), 1000, 800);
    loop = frame(loop, 1010, 700);
    expect(loop).toMatchObject({ pending: 700 });
    expect(loop.inputs).toHaveLength(1);
    loop = frame(loop, 1020, 650);
    expect(loop.pending).toBe(650);
    loop = frame(loop, tickStartMs(31), null);
    expect(loop.inputs).toEqual([
      { t: 1000, x: 800 },
      { t: tickStartMs(31), x: 650 },
    ]);
    expect(loop.pending).toBeNull();
  });

  it("ends on the round's last tick, takes no input past it, and claims what the replay gives", () => {
    let loop = frame(startCatch(1, easy), 44_999, 100);
    expect(loop.ended).toBe(false);
    loop = frame(loop, 45_000, 900);
    expect(loop.ended).toBe(true);
    expect(frame(loop, 45_100, 10)).toBe(loop);
    const late = frame(frame(startCatch(1, easy), 44_000, 100), 45_001, 900);
    expect(late.inputs).toHaveLength(1);
    expect(late.ended).toBe(true);
    expect(replay(catchV1, 1, easy, loop.inputs)).toEqual({ result: catchV1.resultOf(loop.state) });
  });

  it("lists the items falling at the state's tick", () => {
    const start = startCatch(1, easy);
    expect(fallingItems(frame(start, 999, null).state)).toEqual([]);
    expect(fallingItems(frame(start, 1000, null).state)).toEqual([0]);
    const landed = start.state.items[0]?.spawn ?? 0;
    expect(
      fallingItems(frame(start, tickStartMs(landed + easy.fallTicks), null).state),
    ).not.toContain(0);
  });
});

describe("the tap-rush board", () => {
  it("shows the targets up and not hit at a tick", () => {
    const state = tapRushV1.start(4, LEVELS.tap_rush.easy);
    const first = state.targets[0];
    expect(liveTargets(state, 14)).toEqual([]);
    expect(liveTargets(state, 15)).toEqual([0]);
    expect(liveTargets(state, 15 + LEVELS.tap_rush.easy.lifeTicks)).not.toContain(0);
    const hit = tapRushV1.apply(state, { t: 800, cell: first?.cell ?? 0 });
    expect(liveTargets(hit, 30)).not.toContain(0);
  });
});

describe("honest play through the app over a few seeds (the full run is in realtime.calibration.test.ts)", () => {
  it("is never refused, reproduces the app's claim, and keeps t behind the server's clock", () => {
    for (let seed = 0; seed < 12; seed += 1) {
      const level = GAME_LEVELS[seed % 3] ?? "easy";
      for (const played of [
        playCatch(seed, LEVELS.catch[level], prng(seed * 31 + 1)),
        playTapRush(seed, LEVELS.tap_rush[level], prng(seed * 31 + 2)),
      ]) {
        expect(played.judged, `seed ${seed}`).not.toMatchObject({ verdict: "refused" });
        expect(played.judged).toMatchObject({ result: played.claimed });
        expect(played.behindServer).toBe(true);
      }
    }
  });
});
