import { describe, expect, it } from "vitest";
import { mergeReward, type RewardRecord } from "#src/rewards/builder";

const STORED: RewardRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "item",
  name: { ar: "هودي", en: "Hoodie" },
  description: { ar: null, en: "Warm" },
  price: 200,
  stock: 10,
  unitsOut: 3,
  perPlayerLimit: 2,
  opensAt: new Date("2030-11-01T07:00:00Z"),
  closesAt: new Date("2030-11-01T09:00:00Z"),
  section: "merch",
  tags: { new: true, limited: true },
  position: 4,
};
const ZONE = "Asia/Riyadh";

describe("mergeReward", () => {
  it("fills a new reward's defaults", () => {
    expect(mergeReward(undefined, { name: { en: "Cap" }, price: 5, stock: 1 }, ZONE)).toEqual({
      name: { ar: null, en: "Cap" },
      description: { ar: null, en: null },
      price: 5,
      stock: 1,
      perPlayerLimit: null,
      opensAt: null,
      closesAt: null,
      section: null,
      tags: { new: false, limited: false },
    });
  });

  it("keeps every stored field the input leaves out", () => {
    expect(mergeReward(STORED, {}, ZONE)).toEqual({
      name: STORED.name,
      description: STORED.description,
      price: 200,
      stock: 10,
      perPlayerLimit: 2,
      opensAt: STORED.opensAt,
      closesAt: STORED.closesAt,
      section: "merch",
      tags: { new: true, limited: true },
    });
  });

  it("takes what the input sets, and null clears the limit, the times and the section", () => {
    expect(
      mergeReward(
        STORED,
        {
          name: { ar: "قبعة" },
          price: 7,
          stock: 4,
          perPlayerLimit: null,
          opensAt: null,
          closesAt: null,
          section: null,
          tags: { new: false, limited: false },
        },
        ZONE,
      ),
    ).toMatchObject({
      name: { ar: "قبعة", en: null },
      price: 7,
      stock: 4,
      perPlayerLimit: null,
      opensAt: null,
      closesAt: null,
      section: null,
      tags: { new: false, limited: false },
    });
    expect(
      mergeReward(
        STORED,
        { perPlayerLimit: 5, section: "food", opensAt: "2030-11-01T08:00" },
        ZONE,
      ),
    ).toMatchObject({
      perPlayerLimit: 5,
      section: "food",
      opensAt: new Date("2030-11-01T05:00:00Z"),
      closesAt: STORED.closesAt,
    });
  });

  it("refuses a reward with no name in either language", () => {
    expect(mergeReward(undefined, { name: { ar: " ", en: "" }, price: 1, stock: 1 }, ZONE)).toEqual(
      { kind: "invalid", field: "name" },
    );
    expect(mergeReward(STORED, { name: {} }, ZONE)).toEqual({ kind: "invalid", field: "name" });
    expect(mergeReward(STORED, { name: { en: "Only English" } }, ZONE)).not.toHaveProperty("kind");
  });

  it("refuses a time that does not exist, naming which one", () => {
    expect(mergeReward(STORED, { opensAt: "2030-02-30T10:00" }, ZONE)).toEqual({
      kind: "invalid",
      field: "opensAt",
    });
    expect(mergeReward(STORED, { closesAt: "not a time" }, ZONE)).toEqual({
      kind: "invalid",
      field: "closesAt",
    });
  });

  it("refuses a close at or before the open, against the stored times too", () => {
    expect(
      mergeReward(
        undefined,
        { name: { en: "X" }, opensAt: "2030-11-01T10:00", closesAt: "2030-11-01T10:00" },
        ZONE,
      ),
    ).toEqual({ kind: "invalid", field: "closesAt" });
    expect(mergeReward(STORED, { closesAt: "2030-11-01T09:59" }, ZONE)).toEqual({
      kind: "invalid",
      field: "closesAt",
    });
    expect(mergeReward(STORED, { closesAt: "2030-11-01T10:01" }, ZONE)).toMatchObject({
      closesAt: new Date("2030-11-01T07:01:00Z"),
    });
    expect(
      mergeReward(STORED, { opensAt: null, closesAt: "2030-11-01T09:00" }, ZONE),
    ).toMatchObject({ opensAt: null });
    expect(
      mergeReward(
        { ...STORED, opensAt: null, closesAt: null },
        { closesAt: "2030-11-01T09:00" },
        ZONE,
      ),
    ).toMatchObject({ opensAt: null, closesAt: new Date("2030-11-01T06:00:00Z") });
  });
});
