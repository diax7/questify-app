import { describe, expect, it } from "vitest";
import { contactOf, smsText, typedCode } from "#src/players/sign-in";

/** A Retriever hash line the app adds once its signing key exists (FR-1740): a newline and 11 characters. */
const RETRIEVER_LINE = "\nFA+9qCX9VSu";

describe("player sign-in helpers", () => {
  it("fits each SMS in one segment with room for the Retriever hash line", () => {
    // Arabic travels as UCS-2: 70 characters a segment. English is GSM-7: 160.
    expect([...(smsText("123456", "ar") + RETRIEVER_LINE)].length).toBeLessThanOrEqual(70);
    expect((smsText("123456", "en") + RETRIEVER_LINE).length).toBeLessThanOrEqual(160);
    expect(smsText("654321", "ar")).toContain("654321");
    expect(smsText("654321", "en")).toContain("654321");
  });

  it("stores a phone as +9665… and an email in lower case", () => {
    expect(contactOf("phone", "055 123 4567")).toEqual({
      channel: "phone",
      value: "+966551234567",
    });
    expect(contactOf("email", " Player@Najd.SA ")).toEqual({
      channel: "email",
      value: "player@najd.sa",
    });
  });

  it("says why a contact cannot take a code", () => {
    expect(contactOf("phone", "+971501234567")).toEqual({ kind: "phone_not_supported" });
    expect(contactOf("email", "no-at-sign")).toEqual({ kind: "invalid_email" });
    expect(contactOf("email", "@x")).toEqual({ kind: "invalid_email" });
  });

  it("reads a typed code with Arabic-Indic or Persian digits and spaces", () => {
    expect(typedCode(" ١٢٣٤٥٦ ")).toBe("123456");
    expect(typedCode("۷۸۹۰۱۲")).toBe("789012");
    expect(typedCode("123456")).toBe("123456");
  });
});
