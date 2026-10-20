import { describe, expect, it } from "vitest";
import { checkOrganizerName, slugFor } from "#src/organizers/naming";

describe("checkOrganizerName", () => {
  it("accepts ordinary names in Arabic and English, trimmed and with single spaces", () => {
    expect(checkOrganizerName("  Najd   Events ")).toEqual({ ok: true, name: "Najd Events" });
    expect(checkOrganizerName("فعاليات نجد")).toEqual({ ok: true, name: "فعاليات نجد" });
    expect(checkOrganizerName("St. Mary's Club")).toEqual({ ok: true, name: "St. Mary's Club" });
    expect(checkOrganizerName("ab")).toEqual({ ok: true, name: "ab" });
  });

  it("refuses names that are too short or too long", () => {
    expect(checkOrganizerName(" a ")).toEqual({ ok: false, reason: "too_short" });
    expect(checkOrganizerName("ن".repeat(81))).toEqual({ ok: false, reason: "too_long" });
    expect(checkOrganizerName("ن".repeat(80)).ok).toBe(true);
  });

  it("refuses control and invisible formatting characters", () => {
    expect(checkOrganizerName(`Najd${String.fromCodePoint(0x202e)}Events`)).toEqual({
      ok: false,
      reason: "control_characters",
    });
    expect(checkOrganizerName(`Najd${String.fromCodePoint(7)}`)).toEqual({
      ok: false,
      reason: "control_characters",
    });
  });

  it.each([
    "Visit https://pay.example",
    "www.najd",
    "Account suspended, see pay-now.co",
    "Najd.Events",
    "support@najd",
    "PAY-NOW.COM",
  ])("refuses %j, which reads as an address", (name) => {
    expect(checkOrganizerName(name)).toEqual({ ok: false, reason: "looks_like_address" });
  });
});

describe("slugFor", () => {
  it("keeps the Latin letters and digits and adds six random characters", () => {
    expect(slugFor("Najd Events 2026!")).toMatch(/^najd-events-2026-[a-z0-9]{6}$/);
    expect(slugFor("Café Nour")).toMatch(/^cafe-nour-[a-z0-9]{6}$/);
  });

  it("gives an Arabic name a random slug", () => {
    expect(slugFor("فعاليات نجد")).toMatch(/^org-[a-z0-9]{10}$/);
  });

  it("caps the readable part and never leaves a trailing dash", () => {
    const slug = slugFor(`${"a".repeat(39)} b ${"c".repeat(10)}`);
    expect(slug).toMatch(/^[a-z]{39}-[a-z0-9]{6}$/);
  });

  it("makes a different slug each time, and always one the database accepts", () => {
    const slugs = new Set(Array.from({ length: 50 }, () => slugFor("Najd")));
    expect(slugs.size).toBe(50);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});
