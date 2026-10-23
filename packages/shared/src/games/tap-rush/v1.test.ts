import { describe, expect, it } from "vitest";
import { judge, replay } from "#src/games/engine";
import { GAME_LEVELS, LEVELS } from "#src/games/levels";
import {
  scheduleOf,
  TAP_CAP,
  type TapRushInput,
  type TapRushState,
  type TapTarget,
  tapRushV1 as engine,
} from "#src/games/tap-rush/v1";
import { gated, perfectTapRush, seedReaderTapRush } from "#src/games/testing/realtime-players";
import { endTickOf, tickStartMs } from "#src/games/ticks";

const easy = LEVELS.tap_rush.easy;

/** A state with only these targets, to test a rule on its own. */
function only(...targets: TapTarget[]): TapRushState {
  return { ...engine.start(1, easy), targets, hit: targets.map(() => false) };
}

/** Taps in order on a crafted state through the replay's own rules; the first refused tap ends it. */
function tapAll(state: TapRushState, taps: TapRushInput[]) {
  let current = state;
  for (const tap of taps) {
    const refused = engine.refusal(current, tap);
    if (refused !== null) {
      return refused;
    }
    current = engine.apply(current, tap);
  }
  return engine.resultOf(current);
}

/** The first target spawns at tick 15 (500 ms) and lives 45 ticks on easy: up from 500 ms to 2,000 ms. */
const born = tickStartMs(15);
const gone = tickStartMs(15 + easy.lifeTicks);

describe("tap rush: the world", () => {
  it("shows a seed's fixed targets", () => {
    expect(scheduleOf(1, easy).slice(0, 4)).toMatchInlineSnapshot(`
      [
        {
          "cell": 7,
          "spawn": 15,
        },
        {
          "cell": 1,
          "spawn": 37,
        },
        {
          "cell": 4,
          "spawn": 56,
        },
        {
          "cell": 6,
          "spawn": 78,
        },
      ]
    `);
    expect(scheduleOf(-5, LEVELS.tap_rush.medium).slice(0, 3)).toMatchInlineSnapshot(`
      [
        {
          "cell": 6,
          "spawn": 15,
        },
        {
          "cell": 8,
          "spawn": 34,
        },
        {
          "cell": 9,
          "spawn": 50,
        },
      ]
    `);
    expect(scheduleOf(2_000_000_000, LEVELS.tap_rush.hard).slice(0, 3)).toMatchInlineSnapshot(`
      [
        {
          "cell": 9,
          "spawn": 15,
        },
        {
          "cell": 10,
          "spawn": 28,
        },
        {
          "cell": 0,
          "spawn": 41,
        },
      ]
    `);
  });

  it("puts each target in a free cell, at most three up at once, each living out its life in the round", () => {
    for (const name of GAME_LEVELS) {
      const level = LEVELS.tap_rush[name];
      for (let seed = 0; seed < 100; seed += 1) {
        const targets = scheduleOf(seed, level);
        expect(targets[0]?.spawn).toBe(15);
        targets.forEach((target, index) => {
          const up = targets.filter(
            (other) => other.spawn <= target.spawn && target.spawn < other.spawn + level.lifeTicks,
          );
          expect(up.length).toBeLessThanOrEqual(3);
          expect(new Set(up.map((other) => other.cell)).size).toBe(up.length);
          expect(target.cell).toBeLessThan(level.columns * level.rows);
          expect(target.spawn + level.lifeTicks).toBeLessThanOrEqual(
            endTickOf(level.timeLimitSeconds),
          );
          const before = targets[index - 1];
          if (before !== undefined) {
            expect(target.spawn - before.spawn).toBeGreaterThanOrEqual(level.gapMin);
            expect(target.spawn - before.spawn).toBeLessThanOrEqual(level.gapMax);
          }
        });
        const last = targets[targets.length - 1] as TapTarget;
        expect(last.spawn + level.gapMax + level.lifeTicks).toBeGreaterThan(
          endTickOf(level.timeLimitSeconds),
        );
      }
    }
  });
});

describe("tap rush: results", () => {
  it("passes every level with a perfect player", () => {
    for (const name of GAME_LEVELS) {
      const level = LEVELS.tap_rush[name];
      for (const seed of [3, -77, 123_456]) {
        const played = replay(engine, seed, level, perfectTapRush(seed, level));
        const shown = scheduleOf(seed, level).length;
        expect(played, `${name} ${seed}`).toEqual({
          result: { hits: shown, misses: 0, score: shown, quick: 0 },
        });
        if ("result" in played) {
          expect(engine.passes(played.result, level)).toBe(true);
        }
      }
    }
  });

  it("scores hits minus misses, never below 0, so tapping everywhere does not pass", () => {
    expect(replay(engine, 5, easy, [])).toEqual({
      result: { hits: 0, misses: 0, score: 0, quick: 0 },
    });
    const everywhere = Array.from({ length: TAP_CAP }, (_, index) => ({
      t: 100 * index,
      cell: index % 12,
    }));
    const played = replay(engine, 5, easy, gated(engine, 5, easy, everywhere));
    expect(played).toHaveProperty("result");
    if ("result" in played) {
      expect(played.result.misses).toBeGreaterThan(played.result.hits);
      expect(played.result.score).toBe(0);
      expect(engine.passes(played.result, easy)).toBe(false);
    }
    expect(engine.passes({ hits: 25, misses: 5, score: 20, quick: 0 }, easy)).toBe(true);
    expect(engine.passes({ hits: 25, misses: 6, score: 19, quick: 0 }, easy)).toBe(false);
  });

  it("counts a hit under 200 ms as quick, and the level's count of them unlikely", () => {
    const target = { spawn: 15, cell: 4 };
    expect(tapAll(only(target), [{ t: born + 199, cell: 4 }])).toEqual({
      hits: 1,
      misses: 0,
      score: 1,
      quick: 1,
    });
    expect(tapAll(only(target), [{ t: born + 200, cell: 4 }])).toMatchObject({ quick: 0 });
    for (const name of GAME_LEVELS) {
      const level = LEVELS.tap_rush[name];
      const result = { hits: 40, misses: 0, score: 40, quick: level.unlikelyQuick };
      expect(engine.unlikely(result, level)).toBe(true);
      expect(engine.unlikely({ ...result, quick: result.quick - 1 }, level)).toBe(false);
    }
  });

  it("charges a tap on an empty cell, and a second tap on a target already hit", () => {
    const target = { spawn: 15, cell: 4 };
    expect(tapAll(only(target), [{ t: born + 300, cell: 5 }])).toMatchObject({ misses: 1 });
    expect(
      tapAll(only(target), [
        { t: born + 300, cell: 4 },
        { t: born + 400, cell: 4 },
      ]),
    ).toEqual({ hits: 1, misses: 1, score: 0, quick: 0 });
    expect(tapAll(only(target), [{ t: born - 1, cell: 4 }])).toMatchObject({ hits: 0, misses: 1 });
    expect(tapAll(only(target), [{ t: gone - 1, cell: 4 }])).toMatchObject({ hits: 1 });
  });
});

describe("tap rush: the grace after a target goes", () => {
  const target = { spawn: 15, cell: 4 };

  it("neither hits nor charges a tap under 150 ms after a target went, and charges one at 150 ms", () => {
    expect(tapAll(only(target), [{ t: gone, cell: 4 }])).toEqual({
      hits: 0,
      misses: 0,
      score: 0,
      quick: 0,
    });
    expect(tapAll(only(target), [{ t: gone + 149, cell: 4 }])).toMatchObject({ misses: 0 });
    expect(tapAll(only(target), [{ t: gone + 150, cell: 4 }])).toMatchObject({ misses: 1 });
    expect(tapAll(only(target), [{ t: gone + 100, cell: 5 }])).toMatchObject({ misses: 1 });
  });

  it("counts a graced tap toward the floor and the cap", () => {
    const graced = engine.apply(only(target), { t: gone + 10, cell: 4 });
    expect(graced).toMatchObject({ taps: 1, lastT: gone + 10 });
    expect(engine.refusal(graced, { t: gone + 109, cell: 7 })).toBe("too_fast");
  });

  it("gives no grace for a target that was hit", () => {
    expect(
      tapAll(only(target), [
        { t: born + 300, cell: 4 },
        { t: gone + 10, cell: 4 },
      ]),
    ).toMatchObject({ hits: 1, misses: 1 });
  });

  it("lets a live target in the cell decide first: a new target there is hit, or too young to hit", () => {
    const next = { spawn: 15 + easy.lifeTicks, cell: 4 };
    expect(tapAll(only(target, next), [{ t: gone + 130, cell: 4 }])).toEqual({
      hits: 1,
      misses: 0,
      score: 1,
      quick: 1,
    });
    expect(tapAll(only(target, next), [{ t: gone + 50, cell: 4 }])).toBe("too_fast");
  });
});

describe("tap rush: impossible rounds", () => {
  const target = { spawn: 15, cell: 4 };

  it("refuses a hit on a target younger than 120 ms and takes one at 120 ms", () => {
    expect(tapAll(only(target), [{ t: born + 119, cell: 4 }])).toBe("too_fast");
    expect(tapAll(only(target), [{ t: born + 120, cell: 4 }])).toMatchObject({ hits: 1 });
    expect(tapAll(only(target), [{ t: born + 50, cell: 3 }])).toMatchObject({ misses: 1 });
  });

  it("refuses two taps under 100 ms apart and takes them at 100 ms", () => {
    const first = { t: 1000, cell: 0 };
    expect(tapAll(only(target), [first, { t: 1099, cell: 1 }])).toBe("too_fast");
    expect(tapAll(only(target), [first, { t: 1100, cell: 1 }])).toMatchObject({ misses: 2 });
    expect(tapAll(only(target), [first, { t: 999, cell: 1 }])).toBe("order");
  });

  it("takes a tap at the round's length and refuses one a millisecond past it", () => {
    expect(tapAll(only(target), [{ t: 30_000, cell: 0 }])).toMatchObject({ misses: 1 });
    expect(tapAll(only(target), [{ t: 30_001, cell: 0 }])).toBe("late");
  });

  it("takes cell 11 and refuses cell 12", () => {
    expect(tapAll(only(target), [{ t: 1000, cell: 11 }])).toMatchObject({ misses: 1 });
    expect(tapAll(only(target), [{ t: 1000, cell: 12 }])).toBe("illegal");
  });

  it("takes 300 taps and refuses the 301st", () => {
    const taps = Array.from({ length: TAP_CAP + 1 }, (_, index) => ({ t: 100 * index, cell: 0 }));
    expect(tapAll(only(), taps.slice(0, TAP_CAP))).toMatchObject({ misses: TAP_CAP });
    expect(tapAll(only(), taps)).toBe("cap");
  });
});

describe("tap rush: the server's judgement", () => {
  const round = { seed: 8, params: easy };
  const claim = (inputs: TapRushInput[]) => {
    const played = replay(engine, 8, easy, inputs);
    return "result" in played ? played.result : null;
  };

  it("passes a perfect game, and flags a seed reader as unlikely", () => {
    const perfect = perfectTapRush(8, easy);
    expect(judge(engine, round, { inputs: perfect, claimed: claim(perfect) })).toMatchObject({
      verdict: "passed",
      unlikely: false,
    });
    const reader = seedReaderTapRush(8, easy);
    expect(judge(engine, round, { inputs: reader, claimed: claim(reader) })).toMatchObject({
      verdict: "passed",
      unlikely: true,
    });
  });

  it("refuses a claimed result the replay does not reproduce, and malformed inputs", () => {
    expect(
      judge(engine, round, { inputs: [], claimed: { hits: 30, misses: 0, score: 30, quick: 0 } }),
    ).toEqual({ verdict: "refused", reason: "claimed" });
    const claimed = { hits: 0, misses: 0, score: 0, quick: 0 };
    for (const inputs of [
      [{ t: 0, cell: -1 }],
      [{ t: 0, cell: 1.5 }],
      [{ t: 0, cell: 1, x: 2 }],
      Array.from({ length: TAP_CAP * 2 + 1 }, (_, t) => ({ t, cell: 0 })),
    ]) {
      expect(judge(engine, round, { inputs, claimed })).toEqual({
        verdict: "refused",
        reason: "malformed",
      });
    }
  });
});
