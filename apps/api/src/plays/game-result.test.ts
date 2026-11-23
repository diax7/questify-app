import { describe, expect, it } from "vitest";
import { resultLogOf, resultOutcomeOf, type GameResult } from "#src/plays/games";

describe("resultLogOf", () => {
  it("logs the database's verdict and reason", () => {
    expect(resultLogOf({ kind: "done", value: { verdict: "short", reason: "clock" } })).toEqual({
      verdict: "short",
      reason: "clock",
    });
  });

  it("logs an empty reason when the database gave none", () => {
    expect(resultLogOf({ kind: "done", value: { verdict: "passed", reason: null } })).toEqual({
      verdict: "passed",
      reason: "",
    });
  });

  it("logs a refusal's kind with no reason", () => {
    expect(resultLogOf({ kind: "not_found" })).toEqual({ verdict: "not_found", reason: "" });
  });
});

describe("resultOutcomeOf", () => {
  it("turns a refused round into impossible with the attempts left", () => {
    expect(resultOutcomeOf({ impossible: 2 })).toEqual({ kind: "impossible", attemptsLeft: 2 });
    expect(resultOutcomeOf({ impossible: null })).toEqual({
      kind: "impossible",
      attemptsLeft: null,
    });
  });

  it("hands a counted result over as done", () => {
    const result = { verdict: "passed", points: 5 } as unknown as GameResult;
    expect(resultOutcomeOf(result)).toEqual({ kind: "done", value: result });
  });
});
