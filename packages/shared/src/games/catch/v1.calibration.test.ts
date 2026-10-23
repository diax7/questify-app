import { describe, expect, it } from "vitest";
import {
  CATCH_INPUT_CAP,
  type CatchInput,
  type CatchParams,
  catchV1 as engine,
  dropsOf,
} from "#src/games/catch/v1";
import { judge, replay } from "#src/games/engine";
import { GAME_LEVELS, LEVELS } from "#src/games/levels";
import { prng } from "#src/games/prng";
import { honestCatch, seedReaderCatch } from "#src/games/testing/realtime-players";
import { endTickOf, tickStartMs } from "#src/games/ticks";

// Many-seed runs: `pnpm test` and CI run them; Stryker's test run skips `*.calibration.test.ts` (vitest.stryker.config.ts).
const SEEDS = 5000;

/** The share of rounds whose replay is flagged unlikely; a refused round fails the test. */
function flaggedShare(level: CatchParams, inputsOf: (seed: number) => CatchInput[]): number {
  let flagged = 0;
  for (let seed = 0; seed < SEEDS; seed += 1) {
    const played = replay(engine, seed, level, inputsOf(seed));
    if (!("result" in played)) {
      throw new Error(`seed ${seed} was refused: ${played.impossible}`);
    }
    flagged += engine.unlikely(played.result, level) ? 1 : 0;
  }
  return flagged / SEEDS;
}

describe("catch: calibration of the unlikely flag (ADR-217)", () => {
  it("flags under 1% of an honest player's rounds at each level", () => {
    for (const name of GAME_LEVELS) {
      const level = LEVELS.catch[name];
      const share = flaggedShare(level, (seed) =>
        honestCatch(seed, level, prng(seed ^ 0x2545f491)),
      );
      expect(share, name).toBeLessThan(0.01);
    }
  });

  it("flags over 90% of a seed reader's rounds at each level", () => {
    for (const name of GAME_LEVELS) {
      const level = LEVELS.catch[name];
      expect(
        flaggedShare(level, (seed) => seedReaderCatch(seed, level)),
        name,
      ).toBeGreaterThan(0.9);
    }
  });

  it("drops every item within reach and lands them all before the end, over many seeds", () => {
    for (const name of GAME_LEVELS) {
      const level = LEVELS.catch[name];
      for (let seed = 0; seed < SEEDS; seed += 1) {
        const items = dropsOf(seed - 2500, level);
        for (let index = 1; index < items.length; index += 1) {
          const item = items[index] as (typeof items)[number];
          const before = items[index - 1] as (typeof items)[number];
          if (Math.abs(item.x - before.x) > level.basketSpeed * (item.spawn - before.spawn)) {
            throw new Error(`${name} seed ${seed - 2500}: item ${index} out of reach`);
          }
        }
        const last = items[items.length - 1] as (typeof items)[number];
        expect(last.spawn + level.fallTicks).toBeLessThanOrEqual(endTickOf(level.timeLimitSeconds));
      }
    }
  });
});

describe("catch: what one result request can cost the server", () => {
  it("judges the worst-case body (1,351 inputs, the hard level) well inside 150 ms", () => {
    const inputs = Array.from({ length: CATCH_INPUT_CAP }, (_, tick) => ({
      t: tickStartMs(tick),
      x: tick % 2 === 0 ? 0 : 1000,
    }));
    const round = { seed: 77, params: LEVELS.catch.hard };
    const played = replay(engine, 77, LEVELS.catch.hard, inputs);
    const claimed = "result" in played ? played.result : null;
    judge(engine, round, { inputs, claimed });
    const started = performance.now();
    expect(judge(engine, round, { inputs, claimed })).toHaveProperty("verdict", "short");
    expect(performance.now() - started).toBeLessThan(150);
  });
});
