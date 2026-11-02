import { describe, expect, it } from "vitest";
import {
  PLAYER_ACTION_KINDS,
  PLAYER_ACTION_REASONS,
  isActionReason,
  isUsableActionNote,
  tierChangeListSchema,
} from "#src/console-players/console-players";
import { MESSAGES } from "#src/i18n/messages";

const tier = (achievementId: string, which = "bronze") => ({ achievementId, tier: which });

const camel = (code: string): string =>
  code.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

describe("console player action reasons and notes", () => {
  it("accepts each action's own codes only", () => {
    expect(isActionReason("contact_reveal", "legal_request")).toBe(true);
    expect(isActionReason("contact_reveal", "offensive")).toBe(false);
    expect(isActionReason("rename", "offensive")).toBe(true);
    expect(isActionReason("reset_sign_in", "lost_access")).toBe(true);
    expect(isActionReason("reset_sign_in", "")).toBe(false);
    expect(isActionReason("revoke_tiers", "cheating")).toBe(true);
    expect(isActionReason("revoke_tiers", "terms")).toBe(false);
    expect(isActionReason("restore_tiers", "mistake")).toBe(true);
  });

  it("takes 1 to 15 distinct tiers to revoke or restore", () => {
    expect(tierChangeListSchema.safeParse([tier("quests-done")]).success).toBe(true);
    expect(
      tierChangeListSchema.safeParse(Array.from({ length: 15 }, (_, i) => tier(`a${i}`))).success,
    ).toBe(true);
    for (const bad of [
      [],
      Array.from({ length: 16 }, (_, i) => tier(`a${i}`)),
      [tier("quests-done"), tier("quests-done")],
      [tier("quests-done", "platinum")],
      [tier("Quests")],
      [{ ...tier("quests-done"), extra: 1 }],
    ]) {
      expect(tierChangeListSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("accepts a note of 10 to 300 characters once trimmed, without control or direction characters", () => {
    expect(isUsableActionNote("  ten chars!  ")).toBe(true);
    expect(isUsableActionNote("nine char")).toBe(false);
    expect(isUsableActionNote("x".repeat(300))).toBe(true);
    expect(isUsableActionNote("x".repeat(301))).toBe(false);
    expect(isUsableActionNote(`Ticket 12 ${String.fromCharCode(0x202e)} reversed`)).toBe(false);
    expect(isUsableActionNote(`Ticket 12 ${String.fromCharCode(0)} nul char`)).toBe(false);
    expect(isUsableActionNote("ملاحظة عن طلب الدعم رقم 12")).toBe(true);
  });

  it("has Arabic and English words for every reason code and action kind", () => {
    const keys = [
      ...Object.values(PLAYER_ACTION_REASONS)
        .flat()
        .map((code) => `console.player.reason.${camel(code)}`),
      ...PLAYER_ACTION_KINDS.map((kind) => `console.player.action.${camel(kind)}`),
    ];
    for (const key of keys) {
      expect(Object.hasOwn(MESSAGES, key), key).toBe(true);
    }
  });
});
