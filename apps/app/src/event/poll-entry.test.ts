import { describe, expect, it } from "vitest";
import { pollPhase, voteKey, type LastVote } from "#src/event/poll-entry.ts";

describe("pollPhase", () => {
  it("matches the inline closed and voting flags for every closed, mine and left", () => {
    for (const closedByServer of [true, false]) {
      for (const mine of [[], ["a"], ["a", "b"]] as const) {
        for (const left of [null, 0, 1, 59, 3600]) {
          const closed = closedByServer || left === 0;
          const voting = mine.length === 0 && !closed;
          expect(pollPhase({ closed: closedByServer, mine }, left)).toEqual({ closed, voting });
        }
      }
    }
  });
});

describe("voteKey", () => {
  const CHOSEN = [[], ["a"], ["b"], ["a", "b"], ["b", "a"], ["a", "b", "c"], ["c", "b", "a"]];
  const LASTS: readonly (LastVote | undefined)[] = [
    undefined,
    { key: "old", options: "" },
    { key: "old", options: "a" },
    { key: "old", options: "a,b" },
    { key: "old", options: "b,a" },
    { key: "old", options: "a,b,c" },
  ];

  it("matches the inline key choice, drawing a new key only when the choices changed", () => {
    for (const last of LASTS) {
      for (const chosen of CHOSEN) {
        const options = [...chosen].sort().join(",");
        let oldDraws = 0;
        const oldKey = last?.options === options ? last.key : (oldDraws++, "new");
        let draws = 0;
        const next = voteKey(last, chosen, () => {
          draws += 1;
          return "new";
        });
        expect(next).toEqual({ key: oldKey, options });
        expect(draws).toBe(oldDraws);
      }
    }
  });

  it("does not reorder the player's choices", () => {
    const chosen = ["b", "a"];
    voteKey(undefined, chosen, () => "k");
    expect(chosen).toEqual(["b", "a"]);
  });
});
