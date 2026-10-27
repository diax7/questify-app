import { describe, expect, it } from "vitest";
import type { MoveOutcome } from "#src/daily/daily-api.ts";
import { stepAfterMove } from "#src/daily/daily-flow.ts";

const step = (outcome: MoveOutcome<unknown>) => stepAfterMove(outcome, "challenge");

describe("stepAfterMove", () => {
  it("writes an accepted move into the game and says nothing", () => {
    expect(step({ kind: "ok", reply: {} })).toEqual({
      apply: true,
      notice: null,
      reread: false,
      leave: false,
    });
  });

  it.each([
    ["period_over", "daily.periodOver"],
    ["changed", "daily.changed"],
    ["other_language", "daily.otherLanguage"],
  ] as const)("a %s conflict says so and reads the games again", (reason, notice) => {
    expect(step({ kind: "conflict", reason })).toMatchObject({
      apply: false,
      notice,
      reread: true,
    });
  });

  it.each(["out_of_order", "answered", "attempt_taken", "finished"] as const)(
    "a %s conflict only reads the games again: the game moved on elsewhere",
    (reason) => {
      expect(step({ kind: "conflict", reason })).toMatchObject({ notice: null, reread: true });
    },
  );

  it.each([
    ["length", "daily.word.refusedLength"],
    ["letters", "daily.word.refusedLetters"],
    ["not_a_word", "daily.word.refusedNotAWord"],
  ] as const)(
    "a guess refused for %s changes only the line, so the letters stay",
    (reason, notice) => {
      expect(step({ kind: "refused", reason })).toEqual({
        apply: false,
        notice,
        reread: false,
        leave: false,
      });
    },
  );

  it("reads again after a switched-off game or an answer it cannot read", () => {
    expect(step({ kind: "unavailable" })).toMatchObject({
      notice: "daily.unavailable",
      reread: true,
    });
    expect(step({ kind: "failed" })).toMatchObject({ notice: "error.generic", reread: true });
  });

  it("keeps the game as it is when the call was limited or the network was lost", () => {
    expect(step({ kind: "limited" })).toMatchObject({ notice: "daily.limited", reread: false });
    expect(step({ kind: "network" })).toMatchObject({
      notice: "daily.challenge.networkFailed",
      reread: false,
    });
  });

  it("says what a lost connection keeps, in the words of each game", () => {
    expect(stepAfterMove({ kind: "network" }, "word")).toMatchObject({
      notice: "daily.word.networkFailed",
      reread: false,
    });
  });

  it("leaves for the start screen when signed out", () => {
    expect(step({ kind: "signed_out" })).toMatchObject({ leave: true, apply: false });
  });
});
