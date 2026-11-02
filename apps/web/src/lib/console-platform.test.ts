import { HEALTH_COUNT_CAP, type HealthFact } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  ageText,
  cappedCount,
  factValue,
  readAdminAccounts,
  readAdminSessions,
  readHealthView,
  readPlatformNumbers,
} from "#src/lib/console-platform.ts";
import { translatorFor } from "#src/lib/language.ts";

const en = translatorFor("en");
const ar = translatorFor("ar");
const fact = (kind: HealthFact["kind"], value: HealthFact["value"]): HealthFact => ({
  key: "queued",
  kind,
  value,
});

describe("a wait in its largest whole unit", () => {
  it("steps from seconds to minutes, hours and days at the boundaries", () => {
    expect(ageText(en, 59, "en")).toBe("59 s");
    expect(ageText(en, 60, "en")).toBe("1 min");
    expect(ageText(en, 3599, "en")).toBe("59 min");
    expect(ageText(en, 3600, "en")).toBe("1 h");
    expect(ageText(en, 86_399, "en")).toBe("23 h");
    expect(ageText(en, 86_400 * 2 + 5, "en")).toBe("2 d");
  });

  it("uses Western digits with Arabic units", () => {
    expect(ageText(ar, 125, "ar")).toBe("2 د");
    expect(ageText(ar, 7200, "ar")).toBe("2 س");
  });
});

describe("a capped count", () => {
  it("shows the cap as a lower bound and anything below it as is", () => {
    expect(cappedCount(HEALTH_COUNT_CAP - 1, "en")).toBe("10,000");
    expect(cappedCount(HEALTH_COUNT_CAP, "en")).toBe("10,000+");
    expect(cappedCount(HEALTH_COUNT_CAP + 50, "ar")).toBe("10,000+");
    expect(cappedCount(0, "en")).toBe("0");
    expect(cappedCount(100_001, "en", 100_001)).toBe("100,000+");
  });
});

describe("a fact's value", () => {
  it("reads a set-up flag, a missing wait, a percent and a time in words", () => {
    expect(factValue(en, fact("setup", 1), "en")).toBe("Set up");
    expect(factValue(en, fact("setup", 0), "en")).toBe("Not set up");
    expect(factValue(ar, fact("setup", 0), "ar")).toBe("غير مفعّل");
    expect(factValue(en, fact("seconds", null), "en")).toBe("None");
    expect(factValue(en, fact("seconds", 600), "en")).toBe("10 min");
    expect(factValue(en, fact("percent", 87), "en")).toBe("87%");
    expect(factValue(en, fact("percent", null), "en")).toBe("None");
    expect(factValue(en, fact("millis", 12), "en")).toBe("12 ms");
    expect(factValue(en, fact("count", 10_001), "en")).toBe("10,000+");
    expect(factValue(en, fact("text", "M0037"), "en")).toBe("M0037");
    expect(factValue(en, fact("time", "2026-11-02T12:15:00.000Z"), "en")).toMatch(/2 Nov 2026/);
  });
});

describe("the readers of the platform answers", () => {
  it("answer undefined for a body that is not the expected shape", () => {
    for (const read of [
      readHealthView,
      readPlatformNumbers,
      readAdminAccounts,
      readAdminSessions,
    ]) {
      expect(read({ unexpected: true })).toBeUndefined();
      expect(read(null)).toBeUndefined();
    }
  });

  it("read the accounts and sessions lists", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(
      readAdminAccounts({
        admins: [
          {
            id,
            email: "a@questify.test",
            status: "active",
            createdAt: "2026-11-02T10:00:00.000Z",
            sessions: 1,
            lastSeenAt: null,
          },
        ],
      }),
    ).toHaveLength(1);
    expect(readAdminSessions({ sessions: [] })).toEqual([]);
  });
});
