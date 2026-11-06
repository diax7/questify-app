import { describe, expect, it } from "vitest";
import { MESSAGES, NO_OVERRIDES, createTranslator, type Language } from "@questify/shared";
import type { RankRow, Ranking } from "#src/event/home-api.ts";
import type { Translate } from "#src/i18n/words.ts";
import {
  MAX_ROW_HEIGHT,
  PODIUM_ALONE_MAX,
  PODIUM_MAX,
  NAME_LINE,
  PODIUM_MIN,
  podiumFit,
  podiumMetrics,
  podiumPlaces,
  rankingRows,
  rowHeight,
  withLevel,
} from "#src/event/ranking.ts";

const row = (rank: number, isMe = false): RankRow => ({
  rank,
  username: `player${rank}`,
  fullName: null,
  avatar: "fox",
  score: 1000 - rank,
  isMe,
  hidden: false,
});

const topTen = (meAt?: number) =>
  Array.from({ length: 10 }, (_, index) => row(index + 1, index + 1 === meAt));

const ranking = (rows: RankRow[], me: Ranking["me"]): Ranking => ({
  rows,
  me,
  total: 50,
  today: false,
  scores: true,
  names: "username",
});

describe("rankingRows", () => {
  it("shows the top 10 with the player's own row among them, and no 11th row", () => {
    const shown = rankingRows(
      ranking(topTen(4), {
        rank: 4,
        username: "player4",
        fullName: null,
        avatar: "fox",
        score: 996,
      }),
    );
    expect(shown).toHaveLength(10);
    expect(shown.filter((item) => item.isMe).map((item) => item.rank)).toEqual([4]);
  });

  it("adds the player's own row as an 11th row with their real rank", () => {
    const shown = rankingRows(
      ranking(topTen(), { rank: 37, username: "me", fullName: null, avatar: "owl", score: 12 }),
    );
    expect(shown).toHaveLength(11);
    expect(shown[10]).toMatchObject({ rank: 37, username: "me", avatar: "owl", isMe: true });
  });

  it("adds no 11th row for a player ranked exactly 10th", () => {
    const shown = rankingRows(
      ranking(topTen(10), {
        rank: 10,
        username: "player10",
        fullName: null,
        avatar: "fox",
        score: 990,
      }),
    );
    expect(shown).toHaveLength(10);
    expect(shown[9]?.isMe).toBe(true);
  });

  it("invents no rows for a small event, and none for a player without points", () => {
    const six = topTen().slice(0, 6);
    expect(rankingRows(ranking(six, null))).toHaveLength(6);
    expect(rankingRows(ranking([], null))).toEqual([]);
  });

  it("gives every row how the event names players, and the full name the server sent (T-615)", () => {
    const named: Ranking = {
      ...ranking([{ ...row(1), fullName: "Sara Ahmed" }, row(2)], null),
      names: "both",
    };
    const shown = rankingRows(named);
    expect(shown.map((item) => item.names)).toEqual(["both", "both"]);
    expect(shown.map((item) => item.fullName)).toEqual(["Sara Ahmed", null]);
    const own = rankingRows({
      ...named,
      me: { rank: 30, username: "me", fullName: "Me Myself", avatar: "owl", score: 1 },
    });
    expect(own.at(-1)).toMatchObject({ isMe: true, fullName: "Me Myself", names: "both" });
  });

  it("gives every row a key from its rank and username", () => {
    const keys = rankingRows(
      ranking(topTen(), { rank: 37, username: "me", fullName: null, avatar: "owl", score: 1 }),
    ).map((item) => item.key);
    expect(new Set(keys).size).toBe(11);
  });
});

describe("rowHeight", () => {
  it("always fits every slot and its gaps in the space measured", () => {
    for (let available = 0; available <= 900; available += 7) {
      for (const slots of [1, 6, 10, 11]) {
        const height = rowHeight(available, slots, 6);
        expect(height).toBeGreaterThanOrEqual(0);
        expect(height).toBeLessThanOrEqual(MAX_ROW_HEIGHT);
        if (available >= 6 * (slots - 1)) {
          expect(slots * height + 6 * (slots - 1)).toBeLessThanOrEqual(available);
        }
      }
    }
  });

  it("gives the smallest supported phone at least 32 points a row", () => {
    // iPhone SE: about 420 points left for the list (an estimate checked on the phone in T-009).
    expect(rowHeight(420, 11, 6)).toBeGreaterThanOrEqual(32);
  });

  it("stops growing on a tall phone, and gives nothing to no space or no slots", () => {
    expect(rowHeight(2000, 11, 6)).toBe(MAX_ROW_HEIGHT);
    expect(rowHeight(0, 11, 6)).toBe(0);
    expect(rowHeight(20, 11, 6)).toBe(0);
    expect(rowHeight(400, 0, 6)).toBe(0);
  });
});

describe("podiumFit", () => {
  const GAP = 6;
  const total = (available: number, slots: number) => {
    const fit = podiumFit(available, slots, GAP);
    return fit.podium + GAP + slots * fit.row + GAP * (slots - 1);
  };

  it("fits the podium, the rows below it and their gaps in every phone height, with no scrolling", () => {
    for (let available = 380; available <= 900; available += 5) {
      for (const slots of [1, 4, 7, 8]) {
        expect(total(available, slots), `${available} / ${slots}`).toBeLessThanOrEqual(available);
      }
    }
  });

  it("keeps every row readable on the smallest supported phone (8 rows: ranks 4 to 10 and the player's own)", () => {
    // About 420 points are left for the list on an iPhone SE or a small Android (T-009 estimate).
    expect(podiumFit(420, 8, GAP).row).toBeGreaterThanOrEqual(30);
    expect(podiumFit(420, 7, GAP).row).toBeGreaterThanOrEqual(34);
  });

  it("keeps the podium between its bounds and grows with the screen", () => {
    expect(podiumFit(300, 8, GAP).podium).toBe(PODIUM_MIN);
    expect(podiumFit(2000, 8, GAP).podium).toBe(PODIUM_MAX);
    expect(podiumFit(520, 8, GAP).podium).toBeGreaterThan(podiumFit(420, 8, GAP).podium);
  });

  it("lets the podium take the space when nothing is listed below it", () => {
    expect(podiumFit(300, 0, GAP)).toEqual({ podium: 220, row: 0 });
    expect(podiumFit(200, 0, GAP)).toEqual({ podium: 200, row: 0 });
    expect(podiumFit(2000, 0, GAP).podium).toBe(PODIUM_ALONE_MAX);
    expect(podiumFit(0, 0, GAP).podium).toBe(0);
  });
});

describe("podiumPlaces", () => {
  const top = [row(1), row(2), row(3)].map((item) => ({
    ...item,
    key: `${item.rank}`,
    names: "username" as const,
  }));

  it("stands second on one side of first and third on the other", () => {
    expect(podiumPlaces(top).map((place) => place?.rank)).toEqual([2, 1, 3]);
  });

  it("leaves a place that nobody holds empty, for a small event", () => {
    expect(podiumPlaces(top.slice(0, 2)).map((place) => place?.rank)).toEqual([2, 1, undefined]);
    expect(podiumPlaces(top.slice(0, 1)).map((place) => place?.rank)).toEqual([
      undefined,
      1,
      undefined,
    ]);
    expect(podiumPlaces([])).toEqual([undefined, undefined, undefined]);
  });
});

describe("podiumMetrics", () => {
  it("never lets the tallest place go above the podium's height", () => {
    for (let height = PODIUM_MIN; height <= PODIUM_ALONE_MAX; height += 4) {
      for (const withScore of [true, false]) {
        const { face, steps } = podiumMetrics(height, withScore);
        const above = face + NAME_LINE + (withScore ? 18 : 0) + 8;
        expect(above + steps[1], `${height} ${withScore}`).toBeLessThanOrEqual(height);
      }
    }
  });

  it("stands first highest and third lowest", () => {
    for (const withScore of [true, false]) {
      const [second, first, third] = podiumMetrics(126, withScore).steps;
      expect(first).toBeGreaterThan(second);
      expect(second).toBeGreaterThan(third);
      expect(third).toBeGreaterThanOrEqual(10);
    }
  });

  it("makes the steps taller when there is no score line to make room for", () => {
    expect(podiumMetrics(126, false).steps[1]).toBeGreaterThan(podiumMetrics(126, true).steps[1]);
  });

  it("keeps the face readable and in bounds", () => {
    expect(podiumMetrics(PODIUM_MIN, true).face).toBeGreaterThanOrEqual(24);
    expect(podiumMetrics(PODIUM_ALONE_MAX, true).face).toBeLessThanOrEqual(44);
  });

  it("keeps every step tall enough for its rank digit at the smallest podium", () => {
    for (const withScore of [true, false]) {
      const { face, steps, rankText } = podiumMetrics(PODIUM_MIN, withScore);
      const [second, first, third] = steps;
      // The `label` digit is an 18-point line and the step has a 4-point edge.
      expect(Math.min(second, first, third), `${withScore}`).toBeGreaterThanOrEqual(22);
      expect(first).toBeGreaterThan(second);
      expect(second).toBeGreaterThan(third);
      expect(rankText).toBe("label");
      expect(face).toBeGreaterThanOrEqual(24);
    }
  });

  it("measures the smallest podium exactly, with and without a score line", () => {
    expect(podiumMetrics(PODIUM_MIN, true)).toEqual({
      face: 28,
      steps: [24, 28, 22],
      rankText: "label",
    });
    expect(podiumMetrics(PODIUM_MIN, false)).toEqual({
      face: 28,
      steps: [33, 46, 24],
      rankText: "label",
    });
  });

  it("uses the large rank digit only when the shortest step can hold it", () => {
    for (let height = PODIUM_MIN; height <= PODIUM_ALONE_MAX; height += 4) {
      for (const withScore of [true, false]) {
        const { steps, rankText } = podiumMetrics(height, withScore);
        expect(rankText, `${height} ${withScore}`).toBe(steps[2] < 36 ? "label" : "title");
      }
    }
    expect(podiumMetrics(PODIUM_MAX, true).rankText).toBe("title");
  });
});

describe("withLevel (T-404d)", () => {
  const translate = createTranslator(MESSAGES, NO_OVERRIDES);
  const tIn =
    (language: Language): Translate =>
    (key, params) =>
      translate(key, language, params);

  it("ends the spoken row with the player's level, in each language's punctuation", () => {
    expect(withLevel("Rank 2, @sara, 90 pts", 7, tIn("en"), "en")).toBe(
      "Rank 2, @sara, 90 pts, Level 7",
    );
    expect(withLevel("المركز 2، @sara", 7, tIn("ar"), "ar")).toBe("المركز 2، @sara، المستوى 7");
  });

  it("leaves a row without a level as it was (an older API sends none)", () => {
    expect(withLevel("Rank 2, @sara", undefined, tIn("en"), "en")).toBe("Rank 2, @sara");
  });

  it("carries a level on the player's own 11th row", () => {
    const shown = rankingRows(
      ranking(topTen(), {
        rank: 37,
        username: "me",
        fullName: null,
        avatar: "owl",
        score: 12,
        level: 9,
      }),
    );
    expect(shown[10]).toMatchObject({ isMe: true, level: 9 });
  });
});
