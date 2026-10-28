import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_PUSH_BODY_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  announcementBodySchema,
  announcementPushBody,
  announcementRenderable,
  announcementTextIssue,
  checkAnnouncement,
  cleanAnnouncementText,
} from "#src/announcements/announcements";

const GOOD = {
  titleAr: "الغداء جاهز",
  titleEn: "Lunch is ready",
  bodyAr: "يبدأ تقديم الغداء الآن في القاعة 2.",
  bodyEn: "Lunch is served now in hall 2.",
};

const failure = (over: Partial<typeof GOOD>) => {
  const result = checkAnnouncement({ ...GOOD, ...over });
  return result.ok ? null : { field: result.field, issue: result.issue };
};

describe("cleanAnnouncementText", () => {
  it("removes invisible characters, joins whitespace and trims the ends", () => {
    expect(cleanAnnouncementText("  Lunch​  is\n\n ready  now ‏")).toBe("Lunch is ready now");
    expect(cleanAnnouncementText("a️b‍c⁠d﻿e­f")).toBe("abcdef");
  });

  it("turns Arabic-Indic and Persian digits into Western digits (ADR-018)", () => {
    expect(cleanAnnouncementText("القاعة ٢ والطابق ۳")).toBe("القاعة 2 والطابق 3");
  });

  it("keeps a single-code-point emoji and loses a joiner or a variation selector", () => {
    expect(cleanAnnouncementText("Party 🎉")).toBe("Party 🎉");
    expect(cleanAnnouncementText("Love ❤️")).toBe("Love ❤");
  });
});

describe("checkAnnouncement", () => {
  it("cleans the four fields and cuts the two texts for the push", () => {
    const result = checkAnnouncement({ ...GOOD, bodyEn: `  ${"a".repeat(150)}  ` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.titleEn).toBe("Lunch is ready");
    expect(result.draft.bodyEn).toBe("a".repeat(150));
    expect(result.draft.pushBodyEn).toBe(`${"a".repeat(137)}...`);
    expect(result.draft.pushBodyAr).toBe(GOOD.bodyAr);
  });

  it("names the first field that fails, in the order of the form", () => {
    expect(failure({ titleAr: "  ", bodyEn: "" })).toEqual({ field: "titleAr", issue: "required" });
    expect(failure({ bodyAr: "​", titleEn: "" })).toEqual({
      field: "titleEn",
      issue: "required",
    });
    expect(failure({ bodyEn: "" })).toEqual({ field: "bodyEn", issue: "required" });
  });

  it("limits the title to 60 and the text to 500 code points, in both languages", () => {
    expect(failure({ titleEn: "a".repeat(ANNOUNCEMENT_TITLE_MAX) })).toBeNull();
    expect(failure({ titleEn: "a".repeat(ANNOUNCEMENT_TITLE_MAX + 1) })).toEqual({
      field: "titleEn",
      issue: "too_long",
    });
    expect(failure({ titleAr: "ب".repeat(ANNOUNCEMENT_TITLE_MAX + 1) })?.field).toBe("titleAr");
    expect(failure({ bodyAr: "ب".repeat(ANNOUNCEMENT_BODY_MAX) })).toBeNull();
    expect(failure({ bodyAr: "ب".repeat(ANNOUNCEMENT_BODY_MAX + 1) })).toEqual({
      field: "bodyAr",
      issue: "too_long",
    });
    // An emoji outside the BMP is two UTF-16 units and one code point: it counts once, as the database counts.
    expect(failure({ bodyEn: "🎉".repeat(ANNOUNCEMENT_BODY_MAX) })).toBeNull();
    expect(failure({ bodyEn: "🎉".repeat(ANNOUNCEMENT_BODY_MAX + 1) })?.issue).toBe("too_long");
  });

  it("refuses links, addresses and obfuscated dots in all four fields", () => {
    const texts = [
      "Join at https://evil.example/x",
      "write to boss@example.com",
      "see example.com",
      "see example​.​com",
      "see example.️com",
      "see example.́com",
      "see example。com",
      "see ｅｘａｍｐｌｅ．ｃｏｍ",
      "زوروا موقعنا example.sa",
    ];
    for (const text of texts) {
      for (const field of ["titleAr", "titleEn", "bodyAr", "bodyEn"] as const) {
        expect(failure({ [field]: text }), `${field}: ${text}`).toEqual({
          field,
          issue: "looks_like_address",
        });
      }
    }
  });

  it("refuses phone numbers however they are written", () => {
    const numbers = [
      "call 0551234567",
      "call 055 123 4567",
      "call +966 55 123 4567",
      "call 055-123-4567",
      "call (055) 123 4567",
      "اتصل على ٠٥٥١٢٣٤٥٦٧",
      "اتصل على ۰۵۵۱۲۳۴۵۶۷",
      "call 0 5 5 1 2 3 4 5 6 7",
      "call 05​51​23​45​67",
    ];
    for (const text of numbers) {
      expect(failure({ bodyEn: text }), text).toEqual({
        field: "bodyEn",
        issue: "looks_like_phone",
      });
    }
  });

  it("lets ordinary numbers, times and dates through", () => {
    for (const text of [
      "Doors open 10:00 on 30 Oct, hall 2, row 14.",
      "الفعالية من 9:00 إلى 17:30 في القاعة 2.",
      "Prize pickup 12:30 - 14:00.",
      "Win 1,000 points!",
    ]) {
      expect(failure({ bodyEn: text }), text).toBeNull();
    }
  });

  it("refuses the control characters cleaning leaves in", () => {
    expect(failure({ titleEn: "Lunch\u0001" })).toEqual({
      field: "titleEn",
      issue: "control_characters",
    });
    expect(failure({ bodyEn: "a\u0085b" })?.issue).toBe("control_characters");
  });
});

describe("announcementPushBody", () => {
  it("keeps a text that fits and cuts a longer one to 140 code points with three dots", () => {
    const fits = "x".repeat(ANNOUNCEMENT_PUSH_BODY_MAX);
    expect(announcementPushBody(fits)).toBe(fits);
    const cut = announcementPushBody("x".repeat(ANNOUNCEMENT_PUSH_BODY_MAX + 1));
    expect(cut).toBe(`${"x".repeat(137)}...`);
    expect(Array.from(cut)).toHaveLength(ANNOUNCEMENT_PUSH_BODY_MAX);
  });

  it("never splits a surrogate pair and drops a space before the dots", () => {
    const emoji = "🎉".repeat(200);
    const cut = announcementPushBody(emoji);
    expect(cut).toBe(`${"🎉".repeat(137)}...`);
    expect(announcementPushBody(`${"a".repeat(136)} ${"b".repeat(20)}`)).toBe(
      `${"a".repeat(136)}...`,
    );
  });

  it("cuts Arabic text the same way", () => {
    const cut = announcementPushBody("ب".repeat(300));
    expect(Array.from(cut)).toHaveLength(ANNOUNCEMENT_PUSH_BODY_MAX);
    expect(cut.endsWith("...")).toBe(true);
  });
});

describe("announcementTextIssue and announcementRenderable", () => {
  it("judges the title and the text by their own limits", () => {
    expect(announcementTextIssue("a".repeat(61), "titleEn")).toBe("too_long");
    expect(announcementTextIssue("a".repeat(61), "bodyEn")).toBeNull();
    expect(announcementTextIssue("", "bodyAr")).toBe("required");
  });

  it("accepts a cleaned title and cut text and refuses what no longer passes", () => {
    expect(announcementRenderable("Lunch", "Hall 2")).toBe(true);
    expect(announcementRenderable("Lunch", "see example.com")).toBe(false);
    expect(announcementRenderable("a".repeat(61), "Hall 2")).toBe(false);
    expect(announcementRenderable("Lunch", "a".repeat(141))).toBe(false);
    expect(announcementRenderable("", "Hall 2")).toBe(false);
  });
});

describe("announcementBodySchema", () => {
  it("takes the four texts and an optional send time with an offset", () => {
    expect(announcementBodySchema.safeParse(GOOD).success).toBe(true);
    expect(announcementBodySchema.safeParse({ ...GOOD, sendAt: null }).success).toBe(true);
    expect(
      announcementBodySchema.safeParse({ ...GOOD, sendAt: "2026-11-01T09:00:00+03:00" }).success,
    ).toBe(true);
  });

  it("refuses an unknown field (no channel can be chosen), a missing text and a send time without an offset", () => {
    expect(announcementBodySchema.safeParse({ ...GOOD, channels: ["email"] }).success).toBe(false);
    expect(announcementBodySchema.safeParse({ ...GOOD, sms: true }).success).toBe(false);
    expect(announcementBodySchema.safeParse({ titleAr: "x" }).success).toBe(false);
    expect(
      announcementBodySchema.safeParse({ ...GOOD, sendAt: "2026-11-01T09:00:00" }).success,
    ).toBe(false);
    expect(announcementBodySchema.safeParse({ ...GOOD, titleEn: "a".repeat(1001) }).success).toBe(
      false,
    );
  });
});
