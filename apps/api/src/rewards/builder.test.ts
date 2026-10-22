import { describe, expect, it } from "vitest";
import {
  cleanCodes,
  codesRunLow,
  mergeDesk,
  mergeReward,
  pinOf,
  windowsOf,
  type DeskSettings,
  type RewardRecord,
} from "#src/rewards/builder";

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

const digital = (stock: number, unitsOut: number) => ({
  kind: "digital" as const,
  stock,
  unitsOut,
});

describe("codesRunLow (FR-512)", () => {
  it("never warns for an item", () => {
    expect(codesRunLow({ kind: "item", stock: 0, unitsOut: 0 })).toBe(false);
  });

  it("warns at 10% of the codes left, never below 5, and for a reward with none", () => {
    expect(codesRunLow(digital(0, 0))).toBe(true);
    expect(codesRunLow(digital(200, 180))).toBe(true);
    expect(codesRunLow(digital(200, 179))).toBe(false);
    expect(codesRunLow(digital(20, 15))).toBe(true);
    expect(codesRunLow(digital(20, 14))).toBe(false);
    expect(codesRunLow(digital(101, 90))).toBe(true);
    expect(codesRunLow(digital(101, 89))).toBe(false);
  });
});

describe("cleanCodes", () => {
  it("normalizes and drops repeats, keeping the first order", () => {
    expect(cleanCodes([" B ", "A", "B", "e\u0301", "\u00e9"])).toEqual(["B", "A", "\u00e9"]);
  });

  it("refuses the whole upload when one line is not a code", () => {
    expect(cleanCodes(["A", "  "])).toBeUndefined();
  });
});

const day = (date: string, opens: string, closes: string) => ({
  opensAt: `${date}T${opens}`,
  closesAt: `${date}T${closes}`,
});

describe("mergeDesk (FR-1716, ADR-150)", () => {
  const DESK: DeskSettings = {
    location: { ar: "القاعة ب", en: "Hall B" },
    pin: { lat: 24.7, lng: 46.6 },
    hours: [{ opensAt: "2030-01-01T13:00:00.000Z", closesAt: "2030-01-01T19:00:00.000Z" }],
  };
  it("keeps everything when nothing is sent, and each part the input leaves out", () => {
    expect(mergeDesk(DESK, undefined, ZONE)).toBe(DESK);
    expect(mergeDesk(DESK, {}, ZONE)).toEqual(DESK);
    expect(mergeDesk(DESK, { location: { en: "Gate 3" } }, ZONE)).toEqual({
      ...DESK,
      location: { ar: null, en: "Gate 3" },
    });
  });

  it("clears the pin and turns the hours off with null or no windows", () => {
    expect(mergeDesk(DESK, { pin: null }, ZONE)).toEqual({ ...DESK, pin: null });
    expect(mergeDesk(DESK, { hours: null }, ZONE)).toEqual({ ...DESK, hours: null });
    expect(mergeDesk(DESK, { hours: [] }, ZONE)).toEqual({ ...DESK, hours: null });
  });

  it("reads windows in the event's zone, in order, touching allowed", () => {
    expect(
      mergeDesk(
        DESK,
        { hours: [day("2030-01-01", "10:00", "14:00"), day("2030-01-01", "14:00", "18:00")] },
        ZONE,
      ),
    ).toMatchObject({
      hours: [
        { opensAt: "2030-01-01T07:00:00.000Z", closesAt: "2030-01-01T11:00:00.000Z" },
        { opensAt: "2030-01-01T11:00:00.000Z", closesAt: "2030-01-01T15:00:00.000Z" },
      ],
    });
  });

  it("refuses a reversed, empty, overlapping or unreadable window", () => {
    for (const hours of [
      [day("2030-01-01", "14:00", "10:00")],
      [day("2030-01-01", "10:00", "10:00")],
      [day("2030-01-01", "10:00", "14:00"), day("2030-01-01", "13:59", "18:00")],
      [day("2030-01-02", "10:00", "12:00"), day("2030-01-01", "10:00", "12:00")],
      [{ opensAt: "soon", closesAt: "2030-01-01T10:00" }],
      [{ opensAt: "2030-01-01T10:00", closesAt: "later" }],
    ]) {
      expect(mergeDesk(DESK, { hours }, ZONE)).toBe("invalid_hours");
    }
  });
});

describe("windowsOf and pinOf", () => {
  it("pairs the sorted arrays, and answers null when the hours are off", () => {
    const opens = new Date("2030-01-01T10:00:00Z");
    const closes = new Date("2030-01-01T12:00:00Z");
    expect(windowsOf([opens], [closes])).toEqual([
      { opensAt: "2030-01-01T10:00:00.000Z", closesAt: "2030-01-01T12:00:00.000Z" },
    ]);
    expect(windowsOf(null, null)).toBeNull();
    expect(windowsOf([opens], null)).toBeNull();
    expect(windowsOf(null, [closes])).toBeNull();
  });

  it("reads the pin's numeric text, both or neither", () => {
    expect(pinOf("24.713600", "-46.5")).toEqual({ lat: 24.7136, lng: -46.5 });
    expect(pinOf(null, "46")).toBeNull();
    expect(pinOf("24", null)).toBeNull();
  });
});
