import { describe, it } from "vitest";
import { GAME_LEVELS, LEVELS } from "#src/games/levels";
import { prng } from "#src/games/prng";
import { slidePuzzleV1 as engine } from "#src/games/slide-puzzle/v1";
import { expectGateAgreesWithReplay } from "#src/games/testing/gate";

// Many-seed runs: `pnpm test` and CI run them; Stryker's test run skips `*.calibration.test.ts` (vitest.stryker.config.ts).
describe("slide puzzle: properties over many seeds", () => {
  it("lets random taps through the app's gate into a legal round, the gate agreeing with the replay", () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const level = LEVELS.slide_puzzle[GAME_LEVELS[seed % 3] as "easy"];
      const random = prng(seed ^ 0x5bd1e995);
      expectGateAgreesWithReplay(engine, {
        seed,
        level,
        random,
        taps: 200,
        firstGap: 400,
        gap: 1500,
        inputAt: (t) => ({ t, tile: random.below(level.size * level.size + 1) }),
      });
    }
  });
});
