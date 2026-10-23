import { describe, expect, it } from "vitest";
import {
  GAME_LEVELS,
  LEVELS,
  catchV1,
  prng,
  type CatchInput,
  type CatchParams,
} from "@questify/shared";
import { frame, startCatch } from "#src/games/realtime.ts";
import { playCatch, playTapRush } from "#src/games/testing/realtime-play.ts";

// Many-seed runs: `pnpm test` and CI run them; Stryker's test run skips `*.calibration.test.ts` (vitest.stryker.config.ts).
const SEEDS = 500;

/** Feeds recorded inputs to `frame` on another frame schedule: extra empty frames between them, at random times. */
function replayOnOtherFrames(seed: number, params: CatchParams, inputs: readonly CatchInput[]) {
  const random = prng(seed ^ 0x51ed27);
  let loop = startCatch(seed, params);
  let t = 0;
  for (const input of inputs) {
    while (input.t - t > 40) {
      t += 1 + random.below(input.t - t - 1);
      loop = frame(loop, t, null);
    }
    t = input.t;
    loop = frame(loop, t, input.x);
  }
  return catchV1.resultOf(frame(loop, params.timeLimitSeconds * 1000, null).state);
}

describe("honest play through the app's own frame, tap handler, gate and pause, over many seeds", () => {
  it("never refuses an honest catch round, reproduces its claim, and frame timing changes nothing", () => {
    let passed = 0;
    for (const level of GAME_LEVELS) {
      const params = LEVELS.catch[level];
      for (let seed = 0; seed < SEEDS; seed += 1) {
        const played = playCatch(seed, params, prng(seed * 7 + 3));
        expect(played.judged, `${level} ${seed}`).not.toMatchObject({ verdict: "refused" });
        expect(played.judged).toMatchObject({ result: played.claimed });
        expect(played.behindServer).toBe(true);
        expect(replayOnOtherFrames(seed, params, played.inputs as CatchInput[])).toEqual(
          played.claimed,
        );
        passed += played.judged.verdict === "passed" ? 1 : 0;
      }
    }
    expect(passed).toBeGreaterThan(SEEDS);
  });

  it("never refuses an honest tap-rush round and reproduces its claim", () => {
    let passed = 0;
    for (const level of GAME_LEVELS) {
      const params = LEVELS.tap_rush[level];
      for (let seed = 0; seed < SEEDS; seed += 1) {
        const played = playTapRush(seed, params, prng(seed * 7 + 5));
        expect(played.judged, `${level} ${seed}`).not.toMatchObject({ verdict: "refused" });
        expect(played.judged).toMatchObject({ result: played.claimed });
        expect(played.behindServer).toBe(true);
        passed += played.judged.verdict === "passed" ? 1 : 0;
      }
    }
    expect(passed).toBeGreaterThan(SEEDS);
  });
});
