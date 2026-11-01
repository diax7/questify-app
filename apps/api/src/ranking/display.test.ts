import { EMPTY_EQUIPMENT } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { playerRanking } from "#src/ranking/display";
import type { RankingView } from "#src/ranking/ranking";

const view: RankingView = {
  rows: [
    {
      rank: 1,
      username: "sara",
      avatar: "fox",
      equipment: EMPTY_EQUIPMENT,
      score: 910,
      isMe: false,
    },
    {
      rank: 2,
      username: "omar",
      avatar: "owl",
      equipment: EMPTY_EQUIPMENT,
      score: 870,
      isMe: true,
    },
  ],
  me: { rank: 2, username: "omar", avatar: "owl", equipment: EMPTY_EQUIPMENT, score: 870 },
  total: 42,
  today: true,
};

describe("playerRanking", () => {
  it("gives the whole ranking, scores included, and says so", () => {
    expect(playerRanking(view, false)).toEqual({ ...view, scores: true });
  });

  it("leaves every score out of the rows and the player's own place, and says so", () => {
    const answer = playerRanking(view, true);
    expect(answer.scores).toBe(false);
    expect(answer.rows.map((row) => Object.keys(row).toSorted())).toEqual([
      ["avatar", "equipment", "isMe", "rank", "username"],
      ["avatar", "equipment", "isMe", "rank", "username"],
    ]);
    expect(Object.keys(answer.me ?? {}).toSorted()).toEqual([
      "avatar",
      "equipment",
      "rank",
      "username",
    ]);
    expect(JSON.stringify(answer)).not.toMatch(/910|870|score"/);
  });

  it("keeps the places, the players, the total and today's flag", () => {
    expect(playerRanking(view, true)).toEqual({
      rows: [
        { rank: 1, username: "sara", avatar: "fox", equipment: EMPTY_EQUIPMENT, isMe: false },
        { rank: 2, username: "omar", avatar: "owl", equipment: EMPTY_EQUIPMENT, isMe: true },
      ],
      me: { rank: 2, username: "omar", avatar: "owl", equipment: EMPTY_EQUIPMENT },
      total: 42,
      today: true,
      scores: false,
    });
  });

  it("handles an empty ranking and a player who is not ranked", () => {
    const empty: RankingView = { rows: [], me: null, total: 0, today: false };
    expect(playerRanking(empty, true)).toEqual({ ...empty, scores: false });
    expect(playerRanking(empty, false)).toEqual({ ...empty, scores: true });
  });
});
