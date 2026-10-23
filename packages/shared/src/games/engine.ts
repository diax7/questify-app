import type { z } from "zod";

/**
 * Why a replay calls a round impossible (FR-218, FR-1805). The organizer sees the reason; the player never does.
 * `clock` is the database's own check (more play time than the server saw pass) and never comes from an engine.
 */
export type ImpossibleReason =
  | "malformed"
  | "order"
  | "too_fast"
  | "late"
  | "cap"
  | "illegal"
  | "claimed"
  | "clock";

/** The smallest gap between two inputs a person makes (ADR-212). */
export const HUMAN_FLOOR_MS = 100;

/** Every input carries its time in milliseconds from the moment the board showed. */
export type TimedInput = { readonly t: number };

/**
 * One game's rules at one engine version (ADR-212). The same functions draw the app's board, gate its taps and replay
 * the round on the server, so an honest app's claimed result always matches. Bump `engineVersion` whenever a change
 * alters what a replay gives, and keep the old version beside it (`v<n>.ts`) while a round may still use it.
 */
export type GameEngine<Params, State, Input extends TimedInput, Result> = {
  readonly engineVersion: number;
  readonly params: z.ZodType<Params>;
  /** A round's inputs: their shape and the game's cap. */
  readonly inputs: z.ZodType<Input[]>;
  readonly result: z.ZodType<Result>;
  /** The board a seed draws. */
  start(seed: number, params: Params): State;
  /** Why the input cannot be played on this state, or null when it can (the app drops a tap it refuses). */
  refusal(state: State, input: Input): ImpossibleReason | null;
  /** The state after a playable input; the given state is left as it was. */
  apply(state: State, input: Input): State;
  resultOf(state: State): Result;
  passes(result: Result, params: Params): boolean;
  /** Legal play beyond what a person usually does: paid, and flagged for the organizer. */
  unlikely(result: Result, params: Params): boolean;
};

/** The checks every game shares: time order, the human floor and the time limit. */
export function timeRefusal(
  lastT: number | null,
  t: number,
  timeLimitSeconds: number,
): ImpossibleReason | null {
  if (lastT !== null && t < lastT) {
    return "order";
  }
  if (lastT !== null && t - lastT < HUMAN_FLOOR_MS) {
    return "too_fast";
  }
  return t > timeLimitSeconds * 1000 ? "late" : null;
}

export type Replay<Result> = { result: Result } | { impossible: ImpossibleReason };

/** Plays the inputs from the seed; the first input the rules refuse makes the round impossible. */
export function replay<Params, State, Input extends TimedInput, Result>(
  engine: GameEngine<Params, State, Input, Result>,
  seed: number,
  params: Params,
  inputs: readonly Input[],
): Replay<Result> {
  let state = engine.start(seed, params);
  for (const input of inputs) {
    const reason = engine.refusal(state, input);
    if (reason !== null) {
      return { impossible: reason };
    }
    state = engine.apply(state, input);
  }
  return { result: engine.resultOf(state) };
}

/** Whether the app may record this input: the replay's own rules (ADR-212). */
export function canInput<Params, State, Input extends TimedInput, Result>(
  engine: GameEngine<Params, State, Input, Result>,
  state: State,
  input: Input,
): boolean {
  return engine.refusal(state, input) === null;
}

/** The server's verdict on a round (ADR-212). The result travels only with a legal replay. */
export type Judgement =
  | { verdict: "passed" | "short"; result: Record<string, unknown>; unlikely: boolean }
  | { verdict: "refused"; reason: ImpossibleReason };

/** The latest input time of a round's raw inputs, for the database's clock check; 0 when none can be read. */
export function lastInputMs(inputs: unknown): number {
  if (!Array.isArray(inputs)) {
    return 0;
  }
  let last = 0;
  for (const input of inputs) {
    const t = (input as { t?: unknown } | null)?.t;
    if (typeof t === "number" && Number.isSafeInteger(t) && t > last) {
      last = t;
    }
  }
  return last;
}

function sameResult(left: unknown, right: unknown): boolean {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return Object.is(left, right);
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameResult((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}

/**
 * Judges a round from its frozen seed and level and the phone's raw body (ADR-212): malformed inputs, a refused input
 * or a claimed result the replay does not reproduce are `refused`; otherwise the replay's own result passes or not.
 */
export function judge<Params, State, Input extends TimedInput, Result>(
  engine: GameEngine<Params, State, Input, Result>,
  round: { seed: number; params: unknown },
  body: { inputs: unknown; claimed: unknown },
): Judgement {
  const params = engine.params.parse(round.params);
  const inputs = engine.inputs.safeParse(body.inputs);
  const claimed = engine.result.safeParse(body.claimed);
  if (!inputs.success || !claimed.success) {
    return { verdict: "refused", reason: "malformed" };
  }
  const played = replay(engine, round.seed, params, inputs.data);
  if ("impossible" in played) {
    return { verdict: "refused", reason: played.impossible };
  }
  if (!sameResult(played.result, claimed.data)) {
    return { verdict: "refused", reason: "claimed" };
  }
  return {
    verdict: engine.passes(played.result, params) ? "passed" : "short",
    result: played.result as Record<string, unknown>,
    unlikely: engine.unlikely(played.result, params),
  };
}
