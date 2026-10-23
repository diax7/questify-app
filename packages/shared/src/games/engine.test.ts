import { describe, expect, it } from "vitest";
import { HUMAN_FLOOR_MS, lastInputMs, timeRefusal } from "#src/games/engine";

describe("the shared timing rules", () => {
  it("takes a first input at any time inside the limit", () => {
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
