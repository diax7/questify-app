import { describe, expect, it } from "vitest";
import type { RankRow, Ranking } from "#src/event/home-api.ts";
import { MAX_ROW_HEIGHT, rankingRows, rowHeight } from "#src/event/ranking.ts";

const row = (rank: number, isMe = false): RankRow => ({
  rank,
  username: `player${rank}`,
  avatar: "fox",
  score: 1000 - rank,
  isMe,
});

const topTen = (meAt?: number) =>
  Array.from({ length: 10 }, (_, index) => row(index + 1, index + 1 === meAt));

const ranking = (rows: RankRow[], me: Ranking["me"]): Ranking => ({
  rows,
  me,
  total: 50,
  today: false,
});

describe("rankingRows", () => {
  it("shows the top 10 with the player's own row among them, and no 11th row", () => {
    const shown = rankingRows(
      ranking(topTen(4), { rank: 4, username: "player4", avatar: "fox", score: 996 }),
    );
    expect(shown).toHaveLength(10);
    expect(shown.filter((item) => item.isMe).map((item) => item.rank)).toEqual([4]);
  });

  it("adds the player's own row as an 11th row with their real rank", () => {
    const shown = rankingRows(
      ranking(topTen(), { rank: 37, username: "me", avatar: "owl", score: 12 }),
    );
    expect(shown).toHaveLength(11);
    expect(shown[10]).toMatchObject({ rank: 37, username: "me", avatar: "owl", isMe: true });
  });

  it("adds no 11th row for a player ranked exactly 10th", () => {
    const shown = rankingRows(
      ranking(topTen(10), { rank: 10, username: "player10", avatar: "fox", score: 990 }),
    );
    expect(shown).toHaveLength(10);
    expect(shown[9]?.isMe).toBe(true);
  });

  it("invents no rows for a small event, and none for a player without points", () => {
    const six = topTen().slice(0, 6);
    expect(rankingRows(ranking(six, null))).toHaveLength(6);
    expect(rankingRows(ranking([], null))).toEqual([]);
  });

  it("gives every row a key from its rank and username", () => {
    const keys = rankingRows(
      ranking(topTen(), { rank: 37, username: "me", avatar: "owl", score: 1 }),
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
