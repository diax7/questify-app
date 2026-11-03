import type { TeamSponsor } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { souvenirChoices, sponsorOf, taggedLabels, type TagChoices } from "#src/lib/sponsors.ts";

const SPONSOR_ID = "11111111-1111-4111-8111-111111111111";
const RULE_ID = "22222222-2222-4222-8222-222222222222";
const QUEST_ID = "33333333-3333-4333-8333-333333333333";

const sponsor: TeamSponsor = {
  id: SPONSOR_ID,
  nameAr: "الراعي",
  nameEn: "Acme",
  tier: "gold",
  booth: null,
  tags: [
    { kind: "quest", targetId: QUEST_ID },
    { kind: "souvenir", targetId: RULE_ID },
  ],
};

describe("souvenirChoices", () => {
  const body = {
    rules: [
      { id: RULE_ID, item: { name: { ar: "إطار الرحلة", en: "Journey frame" } } },
      { id: QUEST_ID, item: { name: { ar: "لقب", en: null } } },
      { id: SPONSOR_ID },
    ],
  };

  it("names each souvenir in the page's language, the other language when it has only that one", () => {
    expect(souvenirChoices(body, "en")).toEqual([
      { id: RULE_ID, label: "Journey frame" },
      { id: QUEST_ID, label: "لقب" },
      { id: SPONSOR_ID, label: "" },
    ]);
    expect(souvenirChoices(body, "ar")[0]).toEqual({ id: RULE_ID, label: "إطار الرحلة" });
  });

  it("lists nothing for an answer without rules", () => {
    expect(souvenirChoices({}, "en")).toEqual([]);
    expect(souvenirChoices(undefined, "ar")).toEqual([]);
  });
});

describe("tags of a sponsor", () => {
  const choices: TagChoices = {
    quest: [{ id: QUEST_ID, label: "Stage" }],
    category: [],
    reward: [],
    souvenir: [{ id: RULE_ID, label: "Journey frame" }],
  };

  it("finds the sponsor of a souvenir and of nothing else with its id", () => {
    expect(sponsorOf([sponsor], "souvenir", RULE_ID)?.id).toBe(SPONSOR_ID);
    expect(sponsorOf([sponsor], "reward", RULE_ID)).toBeUndefined();
    expect(sponsorOf([sponsor], "souvenir", QUEST_ID)).toBeUndefined();
  });

  it("lists the labels in the order quests, categories, rewards, souvenirs, and leaves out a missing item", () => {
    expect(taggedLabels(sponsor, choices)).toEqual(["Stage", "Journey frame"]);
    expect(taggedLabels(sponsor, { ...choices, souvenir: [] })).toEqual(["Stage"]);
  });
});
