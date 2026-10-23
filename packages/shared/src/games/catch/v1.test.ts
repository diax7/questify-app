import { describe, expect, it } from "vitest";
import {
  CATCH_INPUT_CAP,
  type CatchInput,
  type CatchParams,
  type CatchState,
  catchV1 as engine,
  dropsOf,
} from "#src/games/catch/v1";
import { judge, replay } from "#src/games/engine";
import { GAME_LEVELS, LEVELS } from "#src/games/levels";
import { perfectCatch, seedReaderCatch } from "#src/games/testing/realtime-players";
import { endTickOf, tickStartMs } from "#src/games/ticks";

const easy = LEVELS.catch.easy;
const hard = LEVELS.catch.hard;

/** One input a tick from tick 0, swinging the target from side to side: the longest legal round. */
function swinging(count: number): CatchInput[] {
  return Array.from({ length: count }, (_, tick) => ({
    t: tickStartMs(tick),
    x: tick % 2 === 0 ? 0 : 1000,
  }));
}

/** A state with one item, to test a rule on its own. */
function oneItem(x: number, spawn = 30): CatchState {
  return { ...engine.start(1, easy), items: [{ spawn, x, face: 0 }], sight: ["open"] };
}

/** The first seed whose first item lands more (or no more) than the basket's half from the middle. */
function seedWithFirstItem(far: boolean, level: CatchParams = easy): number {
  for (let seed = 0; ; seed += 1) {
    const first = dropsOf(seed, level)[0];
    if (first !== undefined && Math.abs(first.x - 500) > level.basketHalf === far) {
      return seed;
    }
  }
}

const first = (seed: number) => dropsOf(seed, easy)[0] ?? { spawn: 0, x: 0 };

/** The foreseen count of an easy round, or -1 when it is refused. */
function foreseen(seed: number, inputs: CatchInput[]): number {
  const played = replay(engine, seed, easy, inputs);
  return "result" in played ? played.result.foreseen : -1;
}

const reason = (inputs: CatchInput[]) => replay(engine, 1, easy, inputs);

describe("catch: the world", () => {
  it("drops a seed's fixed items", () => {
    expect(dropsOf(1, easy).slice(0, 4)).toMatchInlineSnapshot(`
      [
        {
          "face": 3,
          "spawn": 30,
          "x": 125,
        },
        {
          "face": 3,
          "spawn": 67,
          "x": 410,
        },
        {
          "face": 0,
          "spawn": 104,
          "x": 79,
        },
        {
          "face": 2,
          "spawn": 135,
          "x": 857,
        },
      ]
    `);
    expect(dropsOf(-5, LEVELS.catch.medium).slice(0, 3)).toMatchInlineSnapshot(`
      [
        {
          "face": 4,
          "spawn": 30,
          "x": 58,
        },
        {
          "face": 2,
          "spawn": 59,
          "x": 861,
        },
        {
          "face": 3,
          "spawn": 81,
          "x": 596,
        },
      ]
    `);
    expect(dropsOf(2_000_000_000, hard).slice(0, 3)).toMatchInlineSnapshot(`
      [
        {
          "face": 2,
          "spawn": 30,
          "x": 856,
        },
        {
          "face": 1,
          "spawn": 55,
          "x": 756,
        },
        {
          "face": 0,
          "spawn": 79,
          "x": 222,
        },
      ]
    `);
  });

  it("drops every item within reach of the one before and lands them all before the end, at every level", () => {
    for (const name of GAME_LEVELS) {
      const level = LEVELS.catch[name];
      for (let seed = 0; seed < 100; seed += 1) {
        const items = dropsOf(seed, level);
        expect(items).toHaveLength(level.items);
        items.forEach((item, index) => {
          const before = items[index - 1];
          expect(item.x).toBeGreaterThanOrEqual(50);
          expect(item.x).toBeLessThanOrEqual(950);
          if (before !== undefined) {
            const gap = item.spawn - before.spawn;
            expect(gap).toBeGreaterThanOrEqual(level.gapMin);
            expect(gap).toBeLessThanOrEqual(level.gapMax);
            expect(Math.abs(item.x - before.x)).toBeLessThanOrEqual(level.basketSpeed * gap);
          }
        });
        expect((items.at(-1)?.spawn ?? 0) + level.fallTicks).toBeLessThanOrEqual(
          endTickOf(level.timeLimitSeconds),
        );
      }
      const worst = 30 + (level.items - 1) * level.gapMax + level.fallTicks;
      expect(worst, name).toBeLessThanOrEqual(endTickOf(level.timeLimitSeconds));
    }
  });

  it("walks the basket toward its target at its speed, never past it", () => {
    const aimed = engine.apply(engine.start(1, easy), { t: 0, x: 1000 });
    expect(engine.advance(aimed, 1).basket).toBe(540);
    expect(engine.advance(aimed, 12).basket).toBe(980);
    expect(engine.advance(aimed, 13).basket).toBe(1000);
    const left = engine.apply(engine.start(1, easy), { t: 0, x: 490 });
    expect(engine.advance(left, 1).basket).toBe(490);
    expect(engine.advance(left, 5).basket).toBe(490);
  });

  it("catches an item landing within the basket's half and misses one just outside", () => {
    expect(engine.resultOf(oneItem(600))).toEqual({ caught: 1, missed: 0, foreseen: 0 });
    expect(engine.resultOf(oneItem(400))).toEqual({ caught: 1, missed: 0, foreseen: 0 });
    expect(engine.resultOf(oneItem(601))).toEqual({ caught: 0, missed: 1, foreseen: 0 });
    expect(engine.advance(oneItem(500), 89)).toMatchObject({ caught: 0, missed: 0, next: 0 });
    expect(engine.advance(oneItem(500), 90)).toMatchObject({ caught: 1, missed: 0, next: 1 });
  });

  it("advances in steps to the same state as in one go, and never back", () => {
    const state = engine.apply(engine.start(9, hard), { t: 0, x: 900 });
    const once = engine.advance(state, 700);
    expect(engine.advance(engine.advance(state, 250), 700)).toEqual(once);
    expect(engine.advance(once, 300)).toBe(once);
    expect(engine.advance(once, 700)).toBe(once);
  });
});

describe("catch: results", () => {
  it("passes every level with a perfect player and catches every item", () => {
    for (const name of GAME_LEVELS) {
      const level = LEVELS.catch[name];
      for (const seed of [3, -77, 123_456]) {
        const played = replay(engine, seed, level, perfectCatch(seed, level));
        expect(played, `${name} ${seed}`).toEqual({
          result: { caught: level.items, missed: 0, foreseen: expect.any(Number) },
        });
        if ("result" in played) {
          expect(engine.passes(played.result, level)).toBe(true);
        }
      }
    }
  });

  it("falls short with a basket that never moves", () => {
    const played = replay(engine, 5, easy, []);
    expect(played).toMatchObject({ result: { foreseen: 0 } });
    if ("result" in played) {
      expect(played.result.caught + played.result.missed).toBe(easy.items);
      expect(engine.passes(played.result, easy)).toBe(false);
    }
    expect(engine.passes({ caught: 20, missed: 10, foreseen: 0 }, easy)).toBe(true);
    expect(engine.passes({ caught: 19, missed: 11, foreseen: 0 }, easy)).toBe(false);
  });

  it("calls the level's count of foreseen catches unlikely and one fewer not", () => {
    for (const name of GAME_LEVELS) {
      const level = LEVELS.catch[name];
      const result = { caught: 30, missed: 0, foreseen: level.unlikelyForesight };
      expect(engine.unlikely(result, level)).toBe(true);
      expect(engine.unlikely({ ...result, foreseen: result.foreseen - 1 }, level)).toBe(false);
    }
  });
});

describe("catch: foresight", () => {
  const far = seedWithFirstItem(true);
  const near = seedWithFirstItem(false);

  it("counts a first move onto a caught item up to 3 ticks after it spawns, and not at 4", () => {
    const item = first(far);
    expect(foreseen(far, [{ t: tickStartMs(item.spawn), x: item.x }])).toBe(1);
    expect(foreseen(far, [{ t: tickStartMs(item.spawn + 3), x: item.x }])).toBe(1);
    expect(foreseen(far, [{ t: tickStartMs(item.spawn + 4), x: item.x }])).toBe(0);
    expect(foreseen(far, [{ t: tickStartMs(item.spawn + 4) - 1, x: item.x }])).toBe(1);
  });

  it("never counts a move made before the item spawned or a target already over it", () => {
    const item = first(far);
    expect(foreseen(far, [{ t: tickStartMs(item.spawn - 1), x: item.x }])).toBe(0);
    expect(
      foreseen(far, [
        { t: tickStartMs(item.spawn - 1), x: item.x },
        { t: tickStartMs(item.spawn + 1), x: item.x + 1 },
      ]),
    ).toBe(0);
    const over = first(near);
    expect(foreseen(near, [{ t: tickStartMs(over.spawn), x: over.x }])).toBe(0);
  });

  it("decides on the first move onto the item: a late one then away and back is not counted", () => {
    const item = first(far);
    const away = item.x > 500 ? 0 : 1000;
    expect(
      foreseen(far, [
        { t: tickStartMs(item.spawn + 4), x: item.x },
        { t: tickStartMs(item.spawn + 5), x: away },
        { t: tickStartMs(item.spawn + 6), x: item.x },
      ]),
    ).toBe(0);
  });

  it("counts a foreseen item only when it is caught", () => {
    const item = first(far);
    const away = item.x > 500 ? 0 : 1000;
    expect(
      foreseen(far, [
        { t: tickStartMs(item.spawn), x: item.x },
        { t: tickStartMs(item.spawn + 1), x: away },
      ]),
    ).toBe(0);
  });
});

describe("catch: impossible rounds", () => {
  it("refuses two inputs on one tick and takes the next tick", () => {
    expect(
      reason([
        { t: 0, x: 10 },
        { t: 33, x: 20 },
      ]),
    ).toEqual({ impossible: "too_fast" });
    expect(
      reason([
        { t: 0, x: 10 },
        { t: 34, x: 20 },
      ]),
    ).toHaveProperty("result");
  });

  it("refuses an input before the one before it", () => {
    expect(
      reason([
        { t: 500, x: 10 },
        { t: 499, x: 20 },
      ]),
    ).toEqual({ impossible: "order" });
  });

  it("takes an input at the round's length and refuses one a millisecond past it", () => {
    expect(reason([{ t: easy.timeLimitSeconds * 1000, x: 10 }])).toHaveProperty("result");
    expect(reason([{ t: easy.timeLimitSeconds * 1000 + 1, x: 10 }])).toEqual({
      impossible: "late",
    });
  });

  it("takes 1,351 inputs and refuses the 1,352nd", () => {
    expect(replay(engine, 1, hard, swinging(CATCH_INPUT_CAP))).toHaveProperty("result");
    const over = [...swinging(CATCH_INPUT_CAP), { t: tickStartMs(CATCH_INPUT_CAP), x: 5 }];
    expect(replay(engine, 1, hard, over)).toEqual({ impossible: "cap" });
  });
});

describe("catch: the server's judgement", () => {
  const round = { seed: 8, params: easy };
  const claim = (inputs: CatchInput[]) => {
    const played = replay(engine, 8, easy, inputs);
    return "result" in played ? played.result : null;
  };

  it("passes a perfect game, and flags a seed reader as unlikely", () => {
    const perfect = perfectCatch(8, easy);
    expect(judge(engine, round, { inputs: perfect, claimed: claim(perfect) })).toMatchObject({
      verdict: "passed",
      result: { caught: 30, missed: 0 },
    });
    const reader = seedReaderCatch(8, easy);
    expect(judge(engine, round, { inputs: reader, claimed: claim(reader) })).toMatchObject({
      verdict: "passed",
      unlikely: true,
    });
  });

  it("refuses a claimed result the replay does not reproduce", () => {
    expect(
      judge(engine, round, { inputs: [], claimed: { caught: 30, missed: 0, foreseen: 0 } }),
    ).toEqual({ verdict: "refused", reason: "claimed" });
  });

  it("refuses malformed inputs", () => {
    const claimed = { caught: 0, missed: 0, foreseen: 0 };
    for (const inputs of [
      [{ t: 0, x: 1001 }],
      [{ t: 0, x: -1 }],
      [{ t: 0, x: 1.5 }],
      [{ t: -1, x: 5 }],
      [{ t: 0, x: 5, y: 1 }],
      [{ t: 0 }],
      swinging(CATCH_INPUT_CAP * 2 + 1),
    ]) {
      expect(judge(engine, round, { inputs, claimed })).toEqual({
        verdict: "refused",
        reason: "malformed",
      });
    }
  });
});
