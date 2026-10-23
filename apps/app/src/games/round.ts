import {
  canInput,
  memoryMatchV1,
  slidePuzzleV1,
  type GameEngine,
  type GameName,
  type MemoryState,
  type TimedInput,
} from "@questify/shared";
import { useCallback, useRef, useState } from "react";

/**
 * The boards this build draws, by game and engine version (ADR-212). The app plays a round with the version frozen on
 * it, so it keeps every version the server may still hand it; a server deploy carrying a new version goes out before
 * the app release that uses it.
 */
const BOARDS = {
  memory_match: { 1: memoryMatchV1 },
  slide_puzzle: { 1: slidePuzzleV1 },
} as const;

/** Whether this build can draw a round of this game at this engine version. */
export function drawable(game: GameName, engineVersion: number): boolean {
  return Object.hasOwn(BOARDS[game], engineVersion);
}

/**
 * One tap through the board's gate (ADR-212, CTO 1): the replay's own rules decide; a tap they refuse is dropped and
 * never recorded, so an honest app never sends a round the server calls impossible.
 */
export function gateTap<P, S, I extends TimedInput, R>(
  engine: GameEngine<P, S, I, R>,
  state: S,
  input: I,
): Readonly<{ accepted: boolean; state: S }> {
  return canInput(engine, state, input)
    ? { accepted: true, state: engine.apply(state, input) }
    : { accepted: false, state };
}

/** Milliseconds since the board showed, on a clock that never jumps (the phone's wall clock may). */
export const monotonicNow = (): number => performance.now();

/**
 * A round being played: the engine's state, the inputs recorded through the gate, with times in whole milliseconds
 * from the moment the board showed (`begin`).
 */
export function useRound<P, S, I extends TimedInput, R>(
  engine: GameEngine<P, S, I, R>,
  seed: number,
  params: P,
  clock: () => number = monotonicNow,
) {
  const [state, setState] = useState(() => engine.start(seed, params));
  const current = useRef(state);
  const inputs = useRef<I[]>([]);
  const shownAt = useRef<number | null>(null);

  const elapsed = useCallback(
    () => (shownAt.current === null ? 0 : Math.floor(clock() - shownAt.current)),
    [clock],
  );
  const begin = useCallback(() => {
    shownAt.current = clock();
  }, [clock]);
  const tap = useCallback(
    (make: (t: number) => I): boolean => {
      const input = make(elapsed());
      const gated = gateTap(engine, current.current, input);
      if (gated.accepted) {
        current.current = gated.state;
        inputs.current.push(input);
        setState(gated.state);
      }
      return gated.accepted;
    },
    [engine, elapsed],
  );
  return { state, current, inputs, begin, elapsed, tap };
}

/** A finished round as the app sends it: the recorded inputs and the engine's own result on the phone. */
export type Finished = Readonly<{ inputs: readonly unknown[]; claimed: unknown }>;

/** Whole seconds left of a time limit after `elapsedMs`; never below 0. */
export const secondsLeftOf = (limitSeconds: number, elapsedMs: number): number =>
  Math.max(0, Math.ceil((limitSeconds * 1000 - elapsedMs) / 1000));

/** Whether a card shows its picture: found, the first of the move, or one of a mismatch still on show. */
export function faceUp(
  state: Pick<MemoryState, "matched" | "open">,
  card: number,
  mismatch: readonly number[] | null,
): boolean {
  return state.matched[card] === true || state.open === card || (mismatch?.includes(card) ?? false);
}
