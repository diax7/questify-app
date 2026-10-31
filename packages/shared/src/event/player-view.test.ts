import { describe, expect, it } from "vitest";
import { FEATURES } from "#src/config/registry";
import { PLAYER_TABS, playerTabs, questTypeShown } from "#src/event/player-view";

describe("playerTabs", () => {
  it("keeps the five tabs in their order while every feature is on", () => {
    expect(playerTabs(() => true).map((entry) => entry.tab)).toEqual([
      "index",
      "quests",
      "scan",
      "rewards",
      "profile",
    ]);
  });

  it("drops the Rewards tab with the shop switch, and nothing else", () => {
    const tabs = playerTabs((feature) => feature !== "shop").map((entry) => entry.tab);
    expect(tabs).toEqual(["index", "quests", "scan", "profile"]);
  });

  it("only names features the app has", () => {
    for (const entry of PLAYER_TABS) {
      expect(entry.feature === null || entry.feature in FEATURES, entry.tab).toBe(true);
    }
  });
});

describe("questTypeShown", () => {
  it("hides a share, meet or game quest with its switch and shows every other type", () => {
    const off = new Set(["shareQuests", "miniGames"]);
    const on = (feature: string) => !off.has(feature);
    expect(questTypeShown("share", on)).toBe(false);
    expect(questTypeShown("game", on)).toBe(false);
    expect(questTypeShown("meet", on)).toBe(true);
    expect(questTypeShown("scan_qr", on)).toBe(true);
  });
});
