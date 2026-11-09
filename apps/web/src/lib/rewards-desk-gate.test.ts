import { describe, expect, it } from "vitest";
import { REWARD_KINDS, needsPrizeDesk, type RewardKind } from "#src/lib/rewards.ts";

/** The form's old inline check: `!editing && draft.kind === "item" && !deskSet`, over every combination. */
const cases: readonly [RewardKind, boolean, boolean, boolean][] = [
  ["item", false, false, true],
  ["item", false, true, false],
  ["item", true, false, false],
  ["item", true, true, false],
  ["experience", false, false, false],
  ["experience", false, true, false],
  ["experience", true, false, false],
  ["digital", false, false, false],
  ["digital", true, true, false],
];

describe("a new reward waits for the prize desk (needsPrizeDesk)", () => {
  it.each(cases)("%s, editing %s, desk set %s", (kind, editing, deskSet, blocked) => {
    expect(needsPrizeDesk(kind, editing, deskSet)).toBe(blocked);
  });

  it("only a new item reward without a desk is blocked", () => {
    const blocked = REWARD_KINDS.flatMap((kind) =>
      [false, true].flatMap((editing) =>
        [false, true]
          .filter((deskSet) => needsPrizeDesk(kind, editing, deskSet))
          .map((deskSet) => `${kind}/${editing}/${deskSet}`),
      ),
    );
    expect(blocked).toEqual(["item/false/false"]);
  });
});
