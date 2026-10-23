import { describe, expect, it } from "vitest";
import { voteCountsOf } from "#src/lib/votes.ts";

const option = { id: "a", text: { ar: null, en: "Robots" }, votes: 2 };

describe("voteCountsOf", () => {
  it("reads each option's count and the total", () => {
    expect(voteCountsOf({ options: [option], total: 2 })).toEqual({ options: [option], total: 2 });
  });

  it.each([
    ["no body", null],
    ["no options", { total: 0 }],
    ["a count that is not a number", { options: [{ ...option, votes: "2" }], total: 2 }],
    ["text without its languages", { options: [{ ...option, text: { en: 1 } }], total: 2 }],
    ["no total", { options: [option] }],
  ])("reads %s as nothing", (_name, body) => {
    expect(voteCountsOf(body)).toBeUndefined();
  });
});
