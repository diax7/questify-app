import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOKS,
  checkLooks,
  readLooks,
  sameLooks,
  scoresHidden,
  type EventLooks,
} from "#src/layout/looks";

const podiumGrid: EventLooks = {
  ranking: { layout: "podium", scores: "rank_only" },
  quests: "grid",
  shop: "grid",
};

describe("readLooks", () => {
  it("reads an event with no looks as the screens have always been drawn", () => {
    for (const stored of [undefined, null, "podium", 7, [], {}]) {
      expect(readLooks(stored)).toEqual(DEFAULT_LOOKS);
    }
  });

  it("reads every allowed choice as stored", () => {
    expect(readLooks(podiumGrid)).toEqual(podiumGrid);
    expect(readLooks({ ranking: { layout: "list", scores: "shown" }, quests: "list" })).toEqual(
      DEFAULT_LOOKS,
    );
  });

  it("falls back to the default layout for a value it does not know, field by field", () => {
    const read = readLooks({
      ranking: { layout: "carousel", scores: "rank_only" },
      quests: "masonry",
      shop: "grid",
    });
    expect(read).toEqual({
      ranking: { layout: "list", scores: "rank_only" },
      quests: "list",
      shop: "grid",
    });
  });

  it("hides the scores when the stored value is there but not understood", () => {
    for (const scores of ["hidden", "SHOWN", "", null, 0, false, true, {}, []]) {
      expect(readLooks({ ranking: { scores } }).ranking.scores).toBe("rank_only");
    }
    expect(readLooks({ ranking: {} }).ranking.scores).toBe("shown");
    expect(readLooks({ ranking: "shown" }).ranking.scores).toBe("shown");
  });

  it("ignores a field it does not know", () => {
    expect(readLooks({ ...podiumGrid, banner: "x" })).toEqual(podiumGrid);
  });
});

describe("checkLooks", () => {
  it("accepts every combination of allowed choices", () => {
    for (const layout of ["list", "podium"] as const) {
      for (const scores of ["shown", "rank_only"] as const) {
        for (const quests of ["list", "grid"] as const) {
          const looks: EventLooks = { ranking: { layout, scores }, quests, shop: "grid" };
          expect(checkLooks(looks)).toEqual({ ok: true, value: looks });
        }
      }
    }
  });

  it.each([
    ["nothing", undefined, "looks"],
    ["a string", "podium", "looks"],
    ["no ranking", { quests: "list", shop: "list" }, "looks.ranking"],
    ["no shop", { ranking: DEFAULT_LOOKS.ranking, quests: "list" }, "looks.shop"],
    ["an unknown layout", { ...DEFAULT_LOOKS, quests: "masonry" }, "looks.quests"],
    [
      "an unknown ranking layout",
      { ...DEFAULT_LOOKS, ranking: { layout: "grid", scores: "shown" } },
      "looks.ranking.layout",
    ],
    [
      "an unknown scores value",
      { ...DEFAULT_LOOKS, ranking: { layout: "list", scores: "hidden" } },
      "looks.ranking.scores",
    ],
  ])("refuses %s and names the field", (_name, input, path) => {
    const checked = checkLooks(input);
    expect(checked.ok).toBe(false);
    expect(checked.ok ? [] : checked.issues.map((issue) => issue.path)).toContain(path);
  });

  it("refuses a field it does not know", () => {
    expect(checkLooks({ ...DEFAULT_LOOKS, extra: 1 }).ok).toBe(false);
    expect(
      checkLooks({ ...DEFAULT_LOOKS, ranking: { ...DEFAULT_LOOKS.ranking, extra: 1 } }).ok,
    ).toBe(false);
  });
});

describe("sameLooks and scoresHidden", () => {
  it("tells apart a change in any one choice", () => {
    expect(sameLooks(DEFAULT_LOOKS, readLooks(undefined))).toBe(true);
    const changes: EventLooks[] = [
      { ...DEFAULT_LOOKS, ranking: { ...DEFAULT_LOOKS.ranking, layout: "podium" } },
      { ...DEFAULT_LOOKS, ranking: { ...DEFAULT_LOOKS.ranking, scores: "rank_only" } },
      { ...DEFAULT_LOOKS, quests: "grid" },
      { ...DEFAULT_LOOKS, shop: "grid" },
    ];
    for (const changed of changes) {
      expect(sameLooks(DEFAULT_LOOKS, changed)).toBe(false);
    }
  });

  it("hides the scores for anything but an explicit shown", () => {
    expect(scoresHidden(DEFAULT_LOOKS)).toBe(false);
    expect(scoresHidden(podiumGrid)).toBe(true);
    expect(scoresHidden(readLooks({ ranking: { scores: "elsewhere" } }))).toBe(true);
  });
});
