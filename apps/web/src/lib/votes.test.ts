import { describe, expect, it } from "vitest";
import { shareOf, voteCountsOf } from "#src/lib/votes.ts";

const option = { id: "a", text: { ar: null, en: "Robots" }, votes: 2 };

describe("voteCountsOf", () => {
  it("reads each option's count, the total and the voters", () => {
    expect(voteCountsOf({ options: [option], total: 2, voters: 2 })).toEqual({
      options: [option],
      total: 2,
      voters: 2,
    });
  });

  it("shares an option out of the voters, past 100% in all with several choices (T-306)", () => {
    expect(shareOf(2, 3)).toBe(67);
    expect(shareOf(3, 3)).toBe(100);
    expect(shareOf(0, 0)).toBe(0);
  });

  it.each([
    ["no body", null],
    ["no options", { total: 0, voters: 0 }],
    ["a count that is not a number", { options: [{ ...option, votes: "2" }], total: 2, voters: 1 }],
    [
      "text without its languages",
      { options: [{ ...option, text: { en: 1 } }], total: 2, voters: 1 },
    ],
    ["no total", { options: [option], voters: 1 }],
    ["no voters", { options: [option], total: 2 }],
  ])("reads %s as nothing", (_name, body) => {
    expect(voteCountsOf(body)).toBeUndefined();
  });
});
