import { INVITATION_NAME_UNITS } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import {
  invitationToken,
  invitationUrl,
  previewInvitation,
  readInvitationToken,
  renderInvitation,
  smsParts,
} from "#src/invitation-campaigns/message";
import { optOutUrl } from "#src/marketing/opt-out";

const keys = createAuthKeys("k".repeat(40));
const PLAYER = "5f3c2a10-9b1e-4d7a-8c55-0a1b2c3d4e5f";
const LINK = "0b9e9f0c-3a4d-4e5f-8a6b-7c8d9e0f1a2b";

const real = (language: "ar" | "en", names: { ar: string | null; en: string | null }) =>
  renderInvitation({
    language,
    names,
    link: invitationUrl(language, invitationToken(LINK)),
    optOut: optOutUrl(keys, { playerId: PLAYER, channel: "sms" }, language),
  });

const linkOf = (language: string) => `https://questify.sa/${language}/i#${invitationToken(LINK)}`;
const optOutOf = (language: "ar" | "en") =>
  optOutUrl(keys, { playerId: PLAYER, channel: "sms" }, language);

describe("the invitation token", () => {
  it("round-trips a link id in 22 base64url characters", () => {
    const token = invitationToken(LINK);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(readInvitationToken(token)).toBe(LINK);
    expect(readInvitationToken(invitationToken(LINK.toUpperCase()))).toBe(LINK);
  });

  it("reads nothing from a malformed or non-canonical token", () => {
    expect(readInvitationToken("short")).toBeNull();
    expect(readInvitationToken(`${invitationToken(LINK)}A`)).toBeNull();
    expect(readInvitationToken("a+bcdefghijklmnopqrstu")).toBeNull();
    // The last character carries 2 spare bits: one with them set decodes to the same bytes but is not canonical.
    const token = invitationToken(LINK);
    const twisted = `${token.slice(0, 21)}${token.endsWith("B") ? "C" : "B"}`;
    expect(readInvitationToken(twisted) === LINK).toBe(false);
  });

  it("refuses to make a token from something that is not a UUID", () => {
    expect(() => invitationToken("not-a-uuid")).toThrow(/link UUID/);
  });

  it("puts the token in the fragment of the language's landing page", () => {
    expect(invitationUrl("ar", "T".repeat(22))).toBe(`https://questify.sa/ar/i#${"T".repeat(22)}`);
    expect(invitationUrl("en", "T".repeat(22))).toBe(`https://questify.sa/en/i#${"T".repeat(22)}`);
  });
});

describe("renderInvitation", () => {
  const names = { ar: "مهرجان الرياض", en: "Riyadh Festival" };

  it("writes the fixed Arabic and English templates with both links", () => {
    const ar = real("ar", names);
    const en = real("en", names);
    expect(ar).toBe(`دعوة إلى مهرجان الرياض: ${linkOf("ar")}\nإيقاف العروض: ${optOutOf("ar")}`);
    expect(en).toBe(
      `Invitation to Riyadh Festival: ${linkOf("en")}\nStop offers: ${optOutOf("en")}`,
    );
  });

  it("falls back to the other language's name when the message's own is missing or blank", () => {
    expect(real("ar", { ar: null, en: "Tech Week" })).toContain("دعوة إلى Tech Week: ");
    expect(real("en", { ar: "أسبوع التقنية", en: "   " })).toContain(
      "Invitation to أسبوع التقنية: ",
    );
    expect(() => real("en", { ar: " ", en: null })).toThrow(/approved event name/);
  });

  it("cuts a long name to 40 units and adds ...", () => {
    const long = "ق".repeat(60);
    expect(real("ar", { ar: long, en: null })).toContain(
      `دعوة إلى ${"ق".repeat(INVITATION_NAME_UNITS)}...: `,
    );
  });

  it("stays within 3 SMS parts for every 40-unit name in either script", () => {
    const fortyArabic = "ف".repeat(INVITATION_NAME_UNITS);
    const fortyLatin = "W".repeat(INVITATION_NAME_UNITS);
    const fortyExtended = "[".repeat(INVITATION_NAME_UNITS);
    const fortyEmoji = "\u{1F389}".repeat(INVITATION_NAME_UNITS);
    for (const name of [fortyArabic, fortyLatin, fortyExtended, fortyEmoji, `${fortyArabic}more`]) {
      for (const language of ["ar", "en"] as const) {
        const text = real(language, { ar: name, en: name });
        expect(smsParts(text), `${language}: ${text.length}`).toBeLessThanOrEqual(3);
      }
    }
    // The longest Arabic case is about 190 UTF-16 units, inside 3 UCS-2 parts (201).
    expect(real("ar", { ar: fortyArabic, en: null }).length).toBeLessThanOrEqual(201);
  });
});

describe("smsParts", () => {
  it("counts GSM-7 septets: 160 alone, 153 a part, extended characters twice", () => {
    expect(smsParts("a".repeat(160))).toBe(1);
    expect(smsParts("a".repeat(161))).toBe(2);
    expect(smsParts("a".repeat(306))).toBe(2);
    expect(smsParts("a".repeat(307))).toBe(3);
    expect(smsParts("[".repeat(80))).toBe(1);
    expect(smsParts("[".repeat(81))).toBe(2);
  });

  it("counts UCS-2 units for anything else: 70 alone, 67 a part", () => {
    expect(smsParts("ع".repeat(70))).toBe(1);
    expect(smsParts("ع".repeat(71))).toBe(2);
    expect(smsParts("ع".repeat(201))).toBe(3);
    expect(smsParts("ع".repeat(202))).toBe(4);
    expect(smsParts(`${"a".repeat(60)}ع`)).toBe(1);
  });
});

describe("previewInvitation", () => {
  it("renders the console's preview with placeholder tokens of the real length, never a real token", () => {
    const names = { ar: "مهرجان الرياض", en: "Riyadh Festival" };
    for (const language of ["ar", "en"] as const) {
      const preview = previewInvitation(names, language);
      const sent = real(language, names);
      expect(preview?.text).toContain(`https://questify.sa/${language}/i#${"X".repeat(22)}`);
      expect(preview?.text).toContain(`opt-out?t=${"X".repeat(44)}`);
      expect(preview?.text.length).toBe(sent.length);
      expect(preview?.parts).toBe(smsParts(sent));
      expect(preview?.text).not.toContain(invitationToken(LINK));
    }
  });

  it("previews nothing when neither name can be sent", () => {
    expect(previewInvitation({ ar: null, en: "  " }, "ar")).toBeNull();
  });
});
