import { describe, expect, it } from "vitest";
import {
  OPEN_GATE,
  decodeBase64Url,
  passes,
  questCodeOrigin,
  questIdOf,
  readScan,
  categoryIdOf,
  stepIdOf,
} from "#src/event/scan.ts";

const QUEST_ID = "5f0c2b1e-8d4a-4c3b-9e7f-0a1b2c3d4e5f";

/** A token laid out as `apps/api/src/quests/qr.ts` signs it: format, quest id, version, a 16-byte tag. */
function token(format = 0x01, id = QUEST_ID): string {
  const bytes = Buffer.concat([
    Buffer.from([format]),
    Buffer.from(id.replaceAll("-", ""), "hex"),
    Buffer.from([0, 0, 0, 1]),
    Buffer.alloc(16, 7),
  ]);
  return bytes.toString("base64url");
}

const STAGING = "https://questify-web-staging-4ecphq.cranl.net";

describe("questCodeOrigin", () => {
  it("defaults to staging in development only, and to none in a release build", () => {
    expect(questCodeOrigin(undefined, true)).toBe(STAGING);
    expect(questCodeOrigin("", true)).toBe(STAGING);
    expect(questCodeOrigin(undefined, false)).toBeNull();
    expect(questCodeOrigin("", false)).toBeNull();
  });

  it("keeps an https origin, plain http only in development, and refuses anything else", () => {
    expect(questCodeOrigin("https://Demo.Questify.test/", false)).toBe(
      "https://demo.questify.test",
    );
    expect(questCodeOrigin("http://192.168.1.5", true)).toBe("http://192.168.1.5");
    expect(() => questCodeOrigin("http://demo.questify.test", false)).toThrow(/must be https/);
    expect(() => questCodeOrigin("not a url", false)).toThrow(/is not an origin/);
    expect(() => questCodeOrigin("https://demo.test/q/abc", false)).toThrow(/is not an origin/);
  });
});

describe("decodeBase64Url", () => {
  it("decodes what Node encodes, without Buffer", () => {
    const sample = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(decodeBase64Url(sample.toString("base64url")) ?? [])).toEqual(
      Array.from(sample),
    );
    expect(decodeBase64Url("")).toEqual(new Uint8Array());
  });

  it("refuses a character outside the base64url alphabet", () => {
    expect(decodeBase64Url("ab+c")).toBeNull();
    expect(decodeBase64Url("ab=")).toBeNull();
  });
});

describe("questIdOf", () => {
  it("reads the quest id of a quest token", () => {
    expect(questIdOf(token())).toBe(QUEST_ID);
  });

  it("refuses another format, length or alphabet", () => {
    expect(questIdOf(token(0x02))).toBeNull();
    expect(questIdOf(token().slice(1))).toBeNull();
    expect(questIdOf(`${token().slice(0, 49)}+`)).toBeNull();
  });
});

describe("stepIdOf (T-304b)", () => {
  it("reads a passport step's id from its own layout only", () => {
    expect(stepIdOf(token(0x04))).toBe(QUEST_ID);
    expect(stepIdOf(token(0x01))).toBeNull();
    expect(questIdOf(token(0x04))).toBeNull();
    expect(stepIdOf(token(0x04).slice(1))).toBeNull();
  });

  it("makes a step's code on Questify's host a step scan", () => {
    expect(readScan(`https://questify.nafes.com/q/${token(0x04)}`, null)).toEqual({
      kind: "step",
      stepId: QUEST_ID,
      token: token(0x04),
    });
    expect(readScan(`https://example.com/q/${token(0x04)}`, null)).toEqual({ kind: "other" });
    expect(readScan(`https://questify.nafes.com/q/${token(0x03)}`, null)).toEqual({
      kind: "other",
    });
  });
});

describe("categoryIdOf (T-304c)", () => {
  it("reads a hidden category's id from its secret code only", () => {
    expect(categoryIdOf(token(0x05))).toBe(QUEST_ID);
    expect(categoryIdOf(token(0x04))).toBeNull();
    expect(stepIdOf(token(0x05))).toBeNull();
    expect(questIdOf(token(0x05))).toBeNull();
  });

  it("makes a secret code on Questify's host a reveal scan", () => {
    expect(readScan(`https://questify.nafes.com/q/${token(0x05)}`, null)).toEqual({
      kind: "reveal",
      categoryId: QUEST_ID,
      token: token(0x05),
    });
    expect(readScan(`https://example.com/q/${token(0x05)}`, null)).toEqual({ kind: "other" });
    expect(readScan(`https://questify.nafes.com/q/${token(0x06)}`, null)).toEqual({
      kind: "other",
    });
  });
});

describe("readScan", () => {
  it("reads a quest code on Questify's host", () => {
    expect(readScan(`https://questify.nafes.com/q/${token()}`, null)).toEqual({
      kind: "quest",
      questId: QUEST_ID,
      token: token(),
    });
    expect(readScan(` https://QUESTIFY.NAFES.COM/q/${token()}/ `, null)).toMatchObject({
      kind: "quest",
    });
  });

  it("reads the build's extra host only when it is configured", () => {
    const link = `${STAGING}/q/${token()}`;
    expect(readScan(link, STAGING)).toMatchObject({ kind: "quest", questId: QUEST_ID });
    expect(readScan(link, null)).toEqual({ kind: "other" });
  });

  it("refuses another host, scheme, path or token", () => {
    for (const text of [
      `https://evil.example/q/${token()}`,
      `http://questify.nafes.com/q/${token()}`,
      `https://questify.nafes.com/x/${token()}`,
      `https://questify.nafes.com/q/${token()}/more`,
      `https://questify.nafes.com/q/${token(0x02)}`,
      "https://questify.nafes.com/q/short",
      `https://user@questify.nafes.com/q/${token()}`,
    ]) {
      expect(readScan(text, null)).toEqual({ kind: "other" });
    }
  });

  it("reads a join link as a join, and never a bare word", () => {
    expect(readScan("https://questify.sa/ar/e/NAJD1", null)).toEqual({
      kind: "join",
      code: "NAJD1",
    });
    expect(readScan("NAJD1", null)).toEqual({ kind: "other" });
    expect(readScan("hello world", null)).toEqual({ kind: "other" });
    expect(readScan("", null)).toEqual({ kind: "other" });
  });
});

describe("the scan gate", () => {
  it("lets a code through when open, and nothing while a scan is answered", () => {
    expect(passes(OPEN_GATE, "a")).toBe(true);
    expect(passes({ busy: true, ignored: null }, "a")).toBe(false);
  });

  it("lets an unrecognised code through once, others still pass", () => {
    const gate = { busy: false, ignored: "poster" };
    expect(passes(gate, "poster")).toBe(false);
    expect(passes(gate, "quest")).toBe(true);
  });
});

describe("meet codes in the scanner", () => {
  it("reads another player's meet code whole, and a malformed one as something else", () => {
    const code = `questify/meet/v1/${"A".repeat(22)}`;
    expect(readScan(code, null)).toEqual({ kind: "meet", code });
    expect(readScan(` ${code} `, null)).toEqual({ kind: "meet", code });
    expect(readScan(`questify/meet/v1/${"A".repeat(21)}`, null)).toEqual({ kind: "other" });
  });
});
