import { describe, expect, it } from "vitest";
import { replay } from "#src/games/engine";
import { GAME_LEVELS, LEVELS } from "#src/games/levels";
import { memoryMatchV1 as engine } from "#src/games/memory-match/v1";
import { prng } from "#src/games/prng";
import { expectGateAgreesWithReplay } from "#src/games/testing/gate";
import { rememberingPlayer } from "#src/games/testing/memory-players";

// Many-seed runs: `pnpm test` and CI run them; Stryker's test run skips `*.calibration.test.ts` (vitest.stryker.config.ts).
describe("memory match: properties over many seeds", () => {
  it("replays the app's own recorded inputs to its claimed result, and an honest app is never impossible", () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const level = LEVELS.memory_match[GAME_LEVELS[seed % 3] as "easy"];
      const { inputs, state } = rememberingPlayer(seed * 7919 - 1_000_000, level, seed);
      expect(replay(engine, seed * 7919 - 1_000_000, level, inputs)).toEqual({
        result: engine.resultOf(state),
      });
    }
  });

  it("passes random taps through the app's gate into a legal round, and the gate agrees with the replay", () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const level = LEVELS.memory_match[GAME_LEVELS[seed % 3] as "easy"];
      const random = prng(seed + 1);
      expectGateAgreesWithReplay(engine, {
        seed,
        level,
        random,
        taps: 300,
        firstGap: 300,
        gap: 900,
        inputAt: (t) => ({ t, card: random.below(level.pairs * 2 + 2) }),
      });
    }
  });

  it("flags fewer than 1% of rounds of a player who remembers every card but never peeks", () => {
    for (const level of GAME_LEVELS) {
      const params = LEVELS.memory_match[level];
      let flagged = 0;
      for (let seed = 0; seed < 5000; seed += 1) {
        const { state } = rememberingPlayer(seed, params, seed + 99_991);
        flagged += engine.unlikely(engine.resultOf(state), params) ? 1 : 0;
      }
      expect(flagged / 5000, level).toBeLessThan(0.01);
    }
  });
});
