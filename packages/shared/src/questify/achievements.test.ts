import type { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  ACHIEVEMENT_TIERS,
  achievementSchema,
  achievementTierSchema,
  achievementsSchema,
  publicAchievementSchema,
} from "#src/questify/achievements";

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
const text = (length: number) => "a".repeat(length);
const achievement = {
  id: "regular",
  name: { ar: "منتظم", en: "Regular" },
  visualKey: "regular",
  tier: "silver",
  progress: 4,
  next: { tier: "gold", target: 10 },
};

describe("achievementTierSchema", () => {
  it("names the three tiers lowest first and refuses any other", () => {
    expect(ACHIEVEMENT_TIERS).toEqual(["bronze", "silver", "gold"]);
    for (const tier of ACHIEVEMENT_TIERS) expect(accepts(achievementTierSchema, tier)).toBe(true);
    for (const tier of ["platinum", "", "Gold", null, undefined])
      expect(accepts(achievementTierSchema, tier)).toBe(false);
  });
});

describe("achievementSchema", () => {
  it("keeps every field of a valid achievement", () => {
    expect(achievementSchema.parse(achievement)).toEqual(achievement);
  });

  it("keeps the silhouette (no tier) and the gold achievement (no next tier)", () => {
    const silhouette = { ...achievement, tier: null, progress: 0 };
    const gold = { ...achievement, tier: "gold", next: null };
    expect(achievementSchema.parse(silhouette)).toEqual(silhouette);
    expect(achievementSchema.parse(gold)).toEqual(gold);
  });

  it("bounds the id to 1..64 characters", () => {
    for (const id of [text(1), text(64)])
      expect(accepts(achievementSchema, { ...achievement, id })).toBe(true);
    for (const id of ["", text(65), 7, undefined])
      expect(accepts(achievementSchema, { ...achievement, id })).toBe(false);
  });

  it("bounds the visual key to 1..40 characters", () => {
    for (const visualKey of [text(1), text(40)])
      expect(accepts(achievementSchema, { ...achievement, visualKey })).toBe(true);
    for (const visualKey of ["", text(41), null, undefined])
      expect(accepts(achievementSchema, { ...achievement, visualKey })).toBe(false);
  });

  it("needs both names as text", () => {
    for (const name of [{ ar: "منتظم" }, { en: "Regular" }, { ar: 1, en: "Regular" }, undefined])
      expect(accepts(achievementSchema, { ...achievement, name })).toBe(false);
  });

  it("refuses a tier outside the three, but a missing tier only as undefined", () => {
    expect(accepts(achievementSchema, { ...achievement, tier: "platinum" })).toBe(false);
    expect(accepts(achievementSchema, { ...achievement, tier: undefined })).toBe(false);
  });

  it("takes progress as a whole number from 0", () => {
    for (const progress of [0, 1, 99])
      expect(accepts(achievementSchema, { ...achievement, progress })).toBe(true);
    for (const progress of [-1, 1.5, "4", undefined])
      expect(accepts(achievementSchema, { ...achievement, progress })).toBe(false);
  });

  it("takes the next tier with a positive whole target", () => {
    for (const target of [1, 500])
      expect(accepts(achievementSchema, { ...achievement, next: { tier: "gold", target } })).toBe(
        true,
      );
    for (const next of [
      { tier: "gold", target: 0 },
      { tier: "gold", target: 2.5 },
      { tier: "gold" },
      { target: 10 },
      { tier: "diamond", target: 10 },
    ])
      expect(accepts(achievementSchema, { ...achievement, next })).toBe(false);
  });
});

describe("achievementsSchema", () => {
  it("keeps the list, empty or not", () => {
    expect(achievementsSchema.parse({ achievements: [achievement] })).toEqual({
      achievements: [achievement],
    });
    expect(achievementsSchema.parse({ achievements: [] })).toEqual({ achievements: [] });
  });

  it("refuses a missing or malformed list", () => {
    for (const value of [{}, { achievements: null }, { achievements: [{ id: "regular" }] }])
      expect(accepts(achievementsSchema, value)).toBe(false);
  });
});

describe("publicAchievementSchema", () => {
  it("keeps the id and tier and drops the progress", () => {
    expect(publicAchievementSchema.parse({ id: "regular", tier: "gold", progress: 9 })).toEqual({
      id: "regular",
      tier: "gold",
    });
    expect(publicAchievementSchema.parse({ id: "regular", tier: null })).toEqual({
      id: "regular",
      tier: null,
    });
  });

  it("bounds the id to 1..64 characters", () => {
    for (const id of [text(1), text(64)])
      expect(accepts(publicAchievementSchema, { id, tier: null })).toBe(true);
    for (const id of ["", text(65)])
      expect(accepts(publicAchievementSchema, { id, tier: null })).toBe(false);
  });
});
