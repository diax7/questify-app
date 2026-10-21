import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import { joinCard } from "#src/join/card";

describe("joinCard", () => {
  it("has a version and says what the organizer receives in Arabic and English", () => {
    const card = joinCard();
    expect(card.version).toMatch(/^[0-9]+(\.[0-9]+){0,2}$/);
    expect(card.receives.length).toBeGreaterThan(0);
    for (const key of [card.title, ...card.receives]) {
      expect(MESSAGES[key].ar.length, key).toBeGreaterThan(0);
      expect(MESSAGES[key].en.length, key).toBeGreaterThan(0);
    }
  });
});
