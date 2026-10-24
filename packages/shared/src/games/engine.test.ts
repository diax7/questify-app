import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  HUMAN_FLOOR_MS,
  judge,
  lastInputMs,
  timeRefusal,
  type GameEngine,
} from "#src/games/engine";

/**
 * A game whose result is whatever the round's params name, so a test picks any result shape the judge compares: an
 * input with t = 13 is refused as illegal.
 */
const echo: GameEngine<unknown, unknown, { t: number }, unknown> = {
  engineVersion: 1,
  params: z.unknown(),
  inputs: z.array(z.strictObject({ t: z.number() })),
  result: z.unknown(),
  start: (_seed, params) => params,
  refusal: (_state, input) => (input.t === 13 ? "illegal" : null),
  apply: (state) => state,
  resultOf: (state) => state,
  passes: () => true,
  unlikely: () => false,
};

const verdictOf = (played: unknown, claimed: unknown, inputs: unknown[] = []) =>
  judge(echo, { seed: 1, params: played }, { inputs, claimed }).verdict;

describe("the judge's comparison of the claimed result with the replay", () => {
  it("passes a claim equal to the replay, key for key and value for value", () => {
    expect(verdictOf({ a: 1, b: { c: null } }, { b: { c: null }, a: 1 })).toBe("passed");
  });

  it("refuses a claim whose value differs in kind from the replay's, either way round", () => {
    expect(verdictOf({ a: 1 }, { a: {} })).toBe("refused");
    expect(verdictOf({ a: {} }, { a: 1 })).toBe("refused");
    expect(verdictOf({ a: null }, { a: {} })).toBe("refused");
    expect(verdictOf({ a: {} }, { a: null })).toBe("refused");
  });

  it("refuses a claim with a key the replay has not, or one missing", () => {
    expect(verdictOf({ a: 1 }, { a: 1, b: 2 })).toBe("refused");
    expect(verdictOf({ a: 1, b: 2 }, { a: 1 })).toBe("refused");
  });

  it("refuses an impossible replay with its own reason, whatever is claimed", () => {
    expect(
      judge(echo, { seed: 1, params: { a: 1 } }, { inputs: [{ t: 13 }], claimed: { a: 1 } }),
    ).toEqual({ verdict: "refused", reason: "illegal" });
  });
});

describe("the shared timing rules", () => {
  it("takes a first input at any time inside the limit", () => {
    expect(timeRefusal(null, -1, 60)).toBeNull();
    expect(timeRefusal(null, 0, 60)).toBeNull();
    expect(timeRefusal(null, 60_000, 60)).toBeNull();
    expect(timeRefusal(null, 60_001, 60)).toBe("late");
  });

  it("refuses an input earlier than the last, or closer than the human floor", () => {
    expect(timeRefusal(1000, 999, 60)).toBe("order");
    expect(timeRefusal(1000, 1000, 60)).toBe("too_fast");
    expect(timeRefusal(1000, 1000 + HUMAN_FLOOR_MS - 1, 60)).toBe("too_fast");
    expect(timeRefusal(1000, 1000 + HUMAN_FLOOR_MS, 60)).toBeNull();
    expect(HUMAN_FLOOR_MS).toBe(100);
  });
});

describe("the last input's time", () => {
  it("is the latest whole time among the inputs, 0 when none is readable", () => {
    expect(lastInputMs([{ t: 5 }, { t: 900 }, { t: 300 }])).toBe(900);
    expect(lastInputMs([])).toBe(0);
    expect(lastInputMs(null)).toBe(0);
    expect(lastInputMs({ t: 5 })).toBe(0);
    expect(lastInputMs([null, { t: "9" }, { t: 1.5 }, { t: -4 }, { t: 2 ** 60 }, { t: 7 }])).toBe(
      7,
    );
  });
});
