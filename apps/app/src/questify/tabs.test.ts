import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "@questify/shared";
import { QUESTIFY_TABS } from "#src/questify/tabs.ts";

describe("the bar outside events (FR-830, T-404d)", () => {
  it("reads Home, Explore, Scan, Journey, Profile, with Scan in the middle", () => {
    expect(QUESTIFY_TABS.map((tab) => tab.name)).toEqual([
      "home",
      "explore",
      "scan",
      "journey",
      "profile",
    ]);
    expect(QUESTIFY_TABS[2]?.name).toBe("scan");
  });

  it("names Journey «رحلتي» in Arabic and Journey in English", () => {
    const journey = QUESTIFY_TABS.find((tab) => tab.name === "journey");
    expect(journey).toBeDefined();
    expect(MESSAGES[journey!.title]).toEqual({ ar: "رحلتي", en: "Journey" });
  });

  it("has a route file for every tab, and a text for every title", () => {
    for (const tab of QUESTIFY_TABS) {
      const route = join(import.meta.dirname, "..", "..", "app", "(questify)", `${tab.name}.tsx`);
      expect(existsSync(route), route).toBe(true);
      expect(MESSAGES[tab.title].ar.length).toBeGreaterThan(0);
    }
  });
});
