import { describe, expect, it } from "vitest";
import { replay } from "#src/games/engine";
import { GAME_LEVELS, LEVELS } from "#src/games/levels";
import { prng } from "#src/games/prng";
import { type TapRushInput, type TapRushParams, tapRushV1 as engine } from "#src/games/tap-rush/v1";
import { honestTapRush, seedReaderTapRush } from "#src/games/testing/realtime-players";

// Many-seed runs: `pnpm test` and CI run them; Stryker's test run skips `*.calibration.test.ts` (vitest.stryker.config.ts).
const SEEDS = 5000;

/** The share of rounds whose replay is flagged unlikely; a refused round fails the test. */
function flaggedShare(level: TapRushParams, inputsOf: (seed: number) => TapRushInput[]): number {
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

describe("tap rush: calibration of the unlikely flag (ADR-217)", () => {
  it("flags under 1% of an honest player's rounds at each level, fast tail included", () => {
    for (const name of GAME_LEVELS) {
      const level = LEVELS.tap_rush[name];
      const share = flaggedShare(level, (seed) =>
        honestTapRush(seed, level, prng(seed ^ 0x2545f491)),
      );
      expect(share, name).toBeLessThan(0.01);
    }
  });

  it("flags over 90% of a seed reader's rounds at each level", () => {
    for (const name of GAME_LEVELS) {
      const level = LEVELS.tap_rush[name];
      expect(
        flaggedShare(level, (seed) => seedReaderTapRush(seed, level)),
        name,
      ).toBeGreaterThan(0.9);
    }
  });
});
