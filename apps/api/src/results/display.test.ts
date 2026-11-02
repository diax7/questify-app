import { describe, expect, it } from "vitest";
import { playerResultsView } from "#src/results/display";
import type { PlayerResults } from "#src/results/results";

const results: PlayerResults = {
  revealed: true,
  names: "both",
  places: [
    {
      rank: 1,
      player: { username: "sara", fullName: "Sara Ahmed", avatar: "fox", hidden: false },
      score: 910,
      prize: { kind: "item", name: { ar: "ذهبية", en: "Gold" } },
      mine: true,
    },
    {
      rank: 2,
      player: { username: null, fullName: null, avatar: "owl", hidden: false },
      score: 870,
      prize: null,
      mine: false,
    },
  ],
  me: {
    rank: 1,
    prize: { kind: "item", name: { ar: "ذهبية", en: "Gold" } },
    redemptionId: "r1",
    status: "reserved",
    claimUntil: null,
  },
};

describe("playerResultsView", () => {
  it("gives the places with their final scores, and says so", () => {
    expect(playerResultsView(results, false)).toEqual({ ...results, scores: true });
  });

  it("leaves every final score out and says so, keeping the rest", () => {
    const answer = playerResultsView(results, true);
    expect(answer.scores).toBe(false);
    expect(answer.places).toEqual([
      {
        rank: 1,
        player: { username: "sara", fullName: "Sara Ahmed", avatar: "fox", hidden: false },
        prize: { kind: "item", name: { ar: "ذهبية", en: "Gold" } },
        mine: true,
      },
      {
        rank: 2,
        player: { username: null, fullName: null, avatar: "owl", hidden: false },
        prize: null,
        mine: false,
      },
    ]);
    expect(answer.names).toBe("both");
    expect(answer.me).toEqual(results.me);
    expect(answer.revealed).toBe(true);
    expect(JSON.stringify(answer)).not.toMatch(/910|870|score"/);
  });

  it("handles results that are not revealed yet", () => {
    const hidden: PlayerResults = { revealed: false, names: "username", places: [], me: null };
    expect(playerResultsView(hidden, true)).toEqual({ ...hidden, scores: false });
  });
});
