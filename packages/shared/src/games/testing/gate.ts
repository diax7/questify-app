import { expect } from "vitest";
import { canInput, type GameEngine, replay, type TimedInput } from "#src/games/engine";
import type { Prng } from "#src/games/prng";

/** One property run: random inputs `gap` ms apart at most, from the seed's board, through the app's gate. */
export type GateRun<P, I> = Readonly<{
  seed: number;
  level: P;
  random: Prng;
  taps: number;
  firstGap: number;
  gap: number;
  inputAt: (t: number) => I;
}>;

/**
 * Plays random inputs through the app's gate (tests only): each input the gate takes replays to the app's own state,
 * each input it drops makes a replay impossible, and the recorded round replays to the app's result.
 */
export function expectGateAgreesWithReplay<P, S, I extends TimedInput, R>(
  engine: GameEngine<P, S, I, R>,
  run: GateRun<P, I>,
): void {
  let state = engine.start(run.seed, run.level);
  const inputs: I[] = [];
  let t = run.random.below(run.firstGap);
  for (let tap = 0; tap < run.taps; tap += 1) {
    const input = run.inputAt(t);
    const allowed = canInput(engine, state, input);
    const next = allowed ? engine.apply(state, input) : state;
    expect(replay(engine, run.seed, run.level, [...inputs, input]), `seed ${run.seed}`).toEqual(
      allowed ? { result: engine.resultOf(next) } : { impossible: expect.any(String) },
    );
    if (allowed) {
      state = next;
      inputs.push(input);
    }
    t += run.random.below(run.gap);
  }
  expect(replay(engine, run.seed, run.level, inputs)).toEqual({ result: engine.resultOf(state) });
}
