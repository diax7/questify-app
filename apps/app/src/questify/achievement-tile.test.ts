import type { Achievement } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { tileTextOf } from "#src/questify/achievement-tile.ts";

const t = (key: string, params?: Readonly<Record<string, string | number>>): string =>
  `${key}${params === undefined ? "" : JSON.stringify(params)}`;

const base: Achievement = {
  id: "a",
  name: { ar: "مستكشف", en: "Explorer" },
  visualKey: "explorer",
  tier: null,
  progress: 2,
  next: { tier: "bronze", target: 5 },
};

const textOf = (achievement: Achievement, withProgress: boolean, language: "ar" | "en" = "en") =>
  tileTextOf(achievement, withProgress, language, t as never);

describe("tileTextOf", () => {
  it("names a locked tile and its progress toward the first tier", () => {
    expect(textOf(base, true)).toEqual({
      name: "Explorer",
      tierName: null,
      nextText: 'achievements.next{"tier":"achievements.tier.bronze","progress":2,"target":5}',
      label:
        'achievements.locked{"name":"Explorer"}. achievements.next{"tier":"achievements.tier.bronze","progress":2,"target":5}',
      topTier: false,
    });
  });

  it("never shows progress on another player's tile", () => {
    expect(textOf(base, false)).toEqual({
      name: "Explorer",
      tierName: null,
      nextText: null,
      label: 'achievements.locked{"name":"Explorer"}',
      topTier: false,
    });
  });

  it("caps the progress at the next target and uses the language's name", () => {
    const silver: Achievement = {
      ...base,
      tier: "silver",
      progress: 99,
      next: { tier: "gold", target: 10 },
    };
    const text = textOf(silver, true, "ar");
    expect(text.name).toBe("مستكشف");
    expect(text.tierName).toBe("achievements.tier.silver");
    expect(text.nextText).toBe(
      'achievements.next{"tier":"achievements.tier.gold","progress":10,"target":10}',
    );
    expect(text.label).toBe(
      'achievements.badge{"name":"مستكشف","tier":"achievements.tier.silver"}. ' + text.nextText,
    );
    expect(text.topTier).toBe(false);
  });

  it("marks the top tier only on the player's own gold badge", () => {
    const gold: Achievement = { ...base, tier: "gold", next: null };
    expect(textOf(gold, true).topTier).toBe(true);
    expect(textOf(gold, true).nextText).toBeNull();
    expect(textOf(gold, false).topTier).toBe(false);
    expect(textOf({ ...gold, tier: "silver" }, true).topTier).toBe(false);
  });
});
