import { describe, expect, it } from "vitest";
import {
  INVITATION_NAME_UNITS,
  invitationNameIssue,
  trimName,
} from "#src/invitation-campaigns/name-rule";

/** True when no surrogate stands alone (ES2023 has no String.prototype.isWellFormed). */
const wellFormed = (text: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

/** Every code point JavaScript itself puts in `\p{Cc}` or `\p{Cf}`, never a hand-written list. */
function controlCodePoints(): number[] {
  const found: number[] = [];
  const control = /^[\p{Cc}\p{Cf}]$/u;
  for (let code = 0; code <= 0x10ffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (control.test(String.fromCodePoint(code))) found.push(code);
  }
  return found;
}

describe("invitationNameIssue (Finding 1 (b))", () => {
  it("refuses every control and format character, generated from JavaScript's own classes", () => {
    const codes = controlCodePoints();
    // The classes hold well over 150 code points, among them the ones a phishing name would use.
    expect(codes.length).toBeGreaterThan(150);
    for (const known of [0x0, 0x7f, 0x200b, 0x200e, 0x202e, 0x2066, 0xfeff, 0xe0001]) {
      expect(codes).toContain(known);
    }
    const missed = codes.filter(
      (code) =>
        invitationNameIssue(`Tech ${String.fromCodePoint(code)}Week`) !== "control_characters",
    );
    expect(missed).toEqual([]);
  });

  it.each([
    "example.com",
    "example。com",
    "example．com",
    "example｡com",
    "example․com",
    "مثال۔كوم",
    "x.y",
    "Join 3.5",
    "a@b",
    "Mail us＠site",
    "http://x",
    "Open hxxps://site",
    "Visit ｅｘａｍｐｌｅ．ｃｏｍ",
  ])("refuses %s as an address", (name) => {
    expect(invitationNameIssue(name)).toBe("looks_like_address");
  });

  it.each(["St. Patrick", "v2 . 0", "Dr. Ahmed", "Tech Week", "مهرجان الرياض", "Season 2026-2027"])(
    "lets %s through",
    (name) => {
      expect(invitationNameIssue(name)).toBeNull();
    },
  );

  it.each([
    "050 123 4567",
    "+966-50-123-4567",
    "Call 0501234567",
    "اتصل ٠٥٠١٢٣٤٥٦٧",
    "Call ０５０１２３４５６７",
    "۰۵۰-۱۲۳-۴۵۶۷",
    "1 2 3 4 5 6 7 8 9",
  ])("refuses %s as a phone number", (name) => {
    expect(invitationNameIssue(name)).toBe("looks_like_phone");
  });

  it("allows a run of 8 digits and refuses one of 9, counting across what is not a letter or a digit", () => {
    expect(invitationNameIssue("Cup 1234-5678")).toBeNull();
    expect(invitationNameIssue("Cup 1234-56789")).toBe("looks_like_phone");
  });

  it("checks the cut text as sent as well as the whole name", () => {
    const long = `${"a".repeat(INVITATION_NAME_UNITS - 7)} example.community`;
    expect(long.length).toBeGreaterThan(INVITATION_NAME_UNITS + 10);
    expect(invitationNameIssue(long)).toBe("looks_like_address");
    const cut = trimName(long);
    expect(cut).toBe(`${"a".repeat(INVITATION_NAME_UNITS - 7)} exampl...`);
    const atTheDot = `${"b".repeat(INVITATION_NAME_UNITS - 12)} example.community`;
    expect(trimName(atTheDot)).toBe(`${"b".repeat(INVITATION_NAME_UNITS - 12)} example.com...`);
    expect(invitationNameIssue(trimName(atTheDot))).toBe("looks_like_address");
  });
});

describe("trimName", () => {
  it("keeps a short name whole, only trimmed", () => {
    expect(trimName("  Tech Week  ")).toBe("Tech Week");
    const exact = "x".repeat(INVITATION_NAME_UNITS);
    expect(trimName(exact)).toBe(exact);
  });

  it("cuts a long name to 40 units and adds ...", () => {
    const name = "y".repeat(INVITATION_NAME_UNITS + 5);
    expect(trimName(name)).toBe(`${"y".repeat(INVITATION_NAME_UNITS)}...`);
  });

  it("never splits a surrogate pair at the cut", () => {
    // 39 units, then an emoji (2 units) across the 40th unit: the emoji is left out whole, never halved.
    const name = `${"z".repeat(INVITATION_NAME_UNITS - 1)}\u{1F389}tail`;
    const cut = trimName(name);
    expect(cut).toBe(`${"z".repeat(INVITATION_NAME_UNITS - 1)}...`);
    expect(wellFormed(cut)).toBe(true);
    for (let at = 30; at < 45; at += 1) {
      const shifted = `${"w".repeat(at)}${"\u{1F389}".repeat(10)}`;
      expect(wellFormed(trimName(shifted))).toBe(true);
      expect(trimName(shifted).length).toBeLessThanOrEqual(INVITATION_NAME_UNITS + 3);
    }
  });
});
