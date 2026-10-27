import { describe, expect, it } from "vitest";
import { classifyJoinScan } from "#src/join/join-scan.ts";

const INVITE = "A".repeat(49) + "Q";
const QUEST_ID = "5f0c2b1e-8d4a-4c3b-9e7f-0a1b2c3d4e5f";

function questToken(format: number): string {
  return Buffer.concat([
    Buffer.from([format]),
    Buffer.from(QUEST_ID.replaceAll("-", ""), "hex"),
    Buffer.from([0, 0, 0, 1]),
    Buffer.alloc(16, 7),
  ]).toString("base64url");
}

describe("classifyJoinScan", () => {
  it("opens an operator invite from the dashboard link and from the app link", () => {
    expect(classifyJoinScan(`https://questify.nafes.com/ar/op#${INVITE}`, null)).toEqual({
      kind: "invite",
      token: INVITE,
    });
    expect(classifyJoinScan(`questify://operator-invite/${INVITE}`, null)).toEqual({
      kind: "invite",
      token: INVITE,
    });
  });

  it("opens a join link with its code in capitals", () => {
    expect(classifyJoinScan("https://questify.sa/en/e/ab12cd", null)).toEqual({
      kind: "join",
      code: "AB12CD",
    });
  });

  it("says to open the event first for every code that works inside an event", () => {
    const origin = "https://questify.nafes.com";
    const inside = [
      `${origin}/q/${questToken(0x01)}`,
      `${origin}/q/${questToken(0x04)}`,
      `${origin}/q/${questToken(0x05)}`,
      `${origin}/s/${questToken(0x07)}`,
      `questify/meet/v1/${"A".repeat(22)}`,
    ];
    for (const text of inside) {
      expect(classifyJoinScan(text, null), text).toEqual({ kind: "event_only" });
    }
  });

  it("calls anything else not a join code, including bare words and rehearsal codes", () => {
    for (const text of [
      "hello",
      "ABCD1234",
      "WXYZ-2345",
      "https://example.com/en/e/ABCD",
      "https://questify.sa/en/e/",
      "",
    ]) {
      expect(classifyJoinScan(text, null), text).toEqual({ kind: "other" });
    }
  });

  it("checks the operator invite before the event scanner's classifier", () => {
    expect(classifyJoinScan(` https://questify.sa/en/op#${INVITE} `, null).kind).toBe("invite");
  });
});
