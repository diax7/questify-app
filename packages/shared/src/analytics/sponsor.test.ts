import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import {
  MIN_GROUP_SIZE,
  groupCount,
  groupParts,
  sponsorTotals,
  sponsorTotalsSchema,
  type SponsorRaw,
} from "#src/analytics/sponsor";

const text = (en: string) => ({ ar: null, en });
const ID = "7d9f3f8e-2b1c-4c43-8f0e-0a2b9f9a1111";

describe("groupCount", () => {
  it("is the number the hint to the organizer names", () => {
    expect(MESSAGES["analytics.sponsor.fewerHint"].en).toContain(` ${MIN_GROUP_SIZE} `);
    expect(MESSAGES["analytics.sponsor.fewerHint"].ar).toContain(` ${MIN_GROUP_SIZE} `);
  });

  it("leaves out one to four and keeps none, five and more", () => {
    expect(MIN_GROUP_SIZE).toBe(5);
    expect([0, 1, 4, 5, 6, 1200].map(groupCount)).toEqual([0, null, null, 5, 6, 1200]);
  });
});

describe("groupParts", () => {
  it("leaves out the smallest shown part with a single hidden one, so a total cannot give it back", () => {
    expect(groupParts([2, 9, 30])).toEqual([null, null, 30]);
    expect(groupParts([30, 2, 9])).toEqual([30, null, null]);
  });

  it("hides nothing more when none or several are already hidden", () => {
    expect(groupParts([7, 9])).toEqual([7, 9]);
    expect(groupParts([1, 2, 9])).toEqual([null, null, 9]);
  });

  it("does not hide a zero, and hides nothing extra when the others are all zero", () => {
    expect(groupParts([3, 0, 0])).toEqual([null, 0, 0]);
    expect(groupParts([3, 0, 8])).toEqual([null, 0, null]);
  });
});

describe("sponsorTotals", () => {
  const raw: SponsorRaw = {
    sponsor: { id: ID, name: text("Acme") },
    visits: 3,
    completions: 42,
    redemptions: 0,
    quests: [
      { id: ID, title: text("Stage"), players: 4 },
      { id: ID, title: text("Booth"), players: 5 },
    ],
    categories: [{ id: ID, name: text("Hall"), players: 0 }],
    rewards: [{ id: ID, name: text("Mug"), redeemed: 0 }],
  };

  it("leaves out each count of one to four and keeps the rest, the sponsor name included", () => {
    const totals = sponsorTotals(raw);
    expect(totals).toMatchObject({ visits: null, completions: 42, redemptions: 0 });
    expect(totals.quests.map((quest) => quest.players)).toEqual([null, 5]);
    expect(totals.categories[0]?.players).toBe(0);
    expect(totals.sponsor.name.en).toBe("Acme");
  });

  it("is a shape the response schema accepts, and nothing about a player fits it", () => {
    expect(sponsorTotalsSchema.safeParse(sponsorTotals(raw)).success).toBe(true);
    expect(sponsorTotalsSchema.safeParse({ ...sponsorTotals(raw), username: "x" }).success).toBe(
      false,
    );
  });

  it("shows every figure as zero for a sponsor with nothing tagged", () => {
    const empty = sponsorTotals({
      ...raw,
      visits: 0,
      completions: 0,
      quests: [],
      categories: [],
      rewards: [],
    });
    expect(empty).toMatchObject({
      visits: 0,
      completions: 0,
      redemptions: 0,
      quests: [],
      rewards: [],
    });
  });
});
