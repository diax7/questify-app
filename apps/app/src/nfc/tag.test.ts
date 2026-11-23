import { describe, expect, it } from "vitest";
import {
  isQuestHost,
  isTagToken,
  messageOf,
  tagTokenOf,
  uidOf,
  uriOfMessage,
  uriOfRecord,
  withPrefix,
} from "#src/nfc/tag.ts";

const TAG_ID = "7c2d0c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
/** A token laid out as `apps/api/src/quests/qr.ts` signs one. */
const token = (format = 0x06) =>
  Buffer.concat([
    Buffer.from([format]),
    Buffer.from(TAG_ID.replaceAll("-", ""), "hex"),
    Buffer.from([0, 0, 0, 1]),
    Buffer.alloc(16, 7),
  ]).toString("base64url");
const URL_OK = `https://questify.nafes.com/t/${token()}`;
const record = (payload: number[], type: number[] | string = [0x55], tnf = 1) => ({
  tnf,
  type,
  payload,
});
const bytes = (text: string) => Array.from(text, (character) => character.charCodeAt(0));

describe("tagTokenOf", () => {
  it("reads a tag's token on a Questify host or the build's extra origin only", () => {
    expect(tagTokenOf(URL_OK, null)).toBe(token());
    expect(tagTokenOf(`https://QUESTIFY.nafes.com/t/${token()}`, null)).toBe(token());
    expect(tagTokenOf(`https://demo.test/t/${token()}`, null)).toBeNull();
    expect(tagTokenOf(`https://demo.test/t/${token()}`, "https://demo.test")).toBe(token());
    expect(tagTokenOf(null, null)).toBeNull();
  });

  it("refuses another format, another path, trailing data and http", () => {
    expect(tagTokenOf(`https://questify.nafes.com/t/${token(0x01)}`, null)).toBeNull();
    expect(tagTokenOf(`https://questify.nafes.com/q/${token()}`, null)).toBeNull();
    expect(tagTokenOf(`${URL_OK}?x=1`, null)).toBeNull();
    expect(tagTokenOf(`${URL_OK}/`, null)).toBeNull();
    expect(tagTokenOf(`${URL_OK}#a`, null)).toBeNull();
    expect(tagTokenOf(URL_OK.replace("https", "http"), null)).toBeNull();
  });
});

describe("uriOfMessage and messageOf", () => {
  it("round-trips the record this app writes", () => {
    const written = messageOf(URL_OK);
    expect(written.slice(0, 4)).toEqual([0xd1, 1, written.length - 4, 0x55]);
    expect(uriOfMessage([record(written.slice(4))])).toBe(URL_OK);
    expect(uriOfMessage([record(written.slice(4), "U")])).toBe(URL_OK);
  });

  it("reads a plain URI record, and nothing else", () => {
    expect(uriOfMessage([record([0, ...bytes(URL_OK)])])).toBe(URL_OK);
    expect(uriOfMessage([record([0x03, ...bytes("questify.nafes.com")])])).toBeNull();
    expect(uriOfMessage([record([0x04, ...bytes("a b")])])).toBeNull();
    expect(uriOfMessage([record([0x04, 0xd9, 0x85])])).toBeNull();
    expect(uriOfMessage([record([0x04, ...bytes("x")], [0x54])])).toBeNull();
    expect(uriOfMessage([record([0x04, ...bytes("x")], "T")])).toBeNull();
    expect(uriOfMessage([record([0x04, ...bytes("x")], [0x55], 3)])).toBeNull();
    expect(uriOfMessage([record([0x04])])).toBeNull();
    const one = record([0x04, ...bytes("questify.nafes.com")]);
    expect(uriOfMessage([one, one])).toBeNull();
    expect(uriOfMessage([])).toBeNull();
    expect(uriOfMessage(null)).toBeNull();
    expect(uriOfMessage(undefined)).toBeNull();
  });

  it("refuses to write anything but a short https URL", () => {
    expect(() => messageOf("http://questify.nafes.com")).toThrow(/Not an https URL/);
    expect(() => messageOf(`https://${"a".repeat(260)}`)).toThrow(/short NDEF record/);
    expect(() => messageOf("https://questify.nafes.com/ä")).toThrow(/short NDEF record/);
  });
});

describe("uidOf", () => {
  it("reads Android's and iOS's hex the same, with or without separators, and bytes", () => {
    expect(uidOf("04A1B2C3D4E5F6")).toBe("04a1b2c3d4e5f6");
    expect(uidOf("04:a1:b2:c3:d4:e5:f6")).toBe("04a1b2c3d4e5f6");
    expect(uidOf("04 A1 B2 C3")).toBe("04a1b2c3");
    expect(uidOf([4, 161, 178, 195, 212, 229, 246])).toBe("04a1b2c3d4e5f6");
  });

  it("is null for no id, a bad one, or one outside 4 to 10 bytes", () => {
    for (const id of [
      undefined,
      null,
      "",
      "04a1b2",
      "zz112233",
      "04a1b2c",
      "00".repeat(11),
      [1, 2, 3],
      [256, 1, 2, 3],
      [1.5, 1, 2, 3],
      42,
    ]) {
      expect(uidOf(id), String(id)).toBeNull();
    }
    expect(uidOf("00".repeat(10))).toBe("00".repeat(10));
  });
});

describe("the tag's helpers", () => {
  it("isQuestHost takes a Questify host or the build's extra origin only", () => {
    expect(isQuestHost("questify.nafes.com", null)).toBe(true);
    expect(isQuestHost("elsewhere.example", "https://elsewhere.example")).toBe(true);
    expect(isQuestHost("elsewhere.example", "https://other.example")).toBe(false);
    expect(isQuestHost("elsewhere.example", null)).toBe(false);
  });

  it("isTagToken wants 37 bytes that start with the tag format", () => {
    expect(isTagToken(token())).toBe(true);
    expect(isTagToken(token(0x01))).toBe(false);
    expect(isTagToken(Buffer.alloc(36, 6).toString("base64url"))).toBe(false);
    expect(isTagToken("***")).toBe(false);
  });

  it("withPrefix adds https:// for code 4, keeps plain text for code 0, refuses the rest", () => {
    expect(withPrefix(4, "a.sa/t/x")).toBe("https://a.sa/t/x");
    expect(withPrefix(0, "https://a.sa/t/x")).toBe("https://a.sa/t/x");
    expect(withPrefix(3, "a.sa")).toBeNull();
    expect(withPrefix(undefined, "a.sa")).toBeNull();
    expect(withPrefix(4, null)).toBeNull();
    expect(withPrefix(0, null)).toBeNull();
  });

  it("uriOfRecord reads one well-known URI record and nothing else", () => {
    expect(uriOfRecord({ tnf: 1, type: "U", payload: [4, ...bytes("a.sa")] })).toBe("https://a.sa");
    expect(uriOfRecord({ tnf: 1, type: [0x55], payload: [0, ...bytes("x:y")] })).toBe("x:y");
    expect(uriOfRecord({ tnf: 2, type: "U", payload: [4, ...bytes("a.sa")] })).toBeNull();
    expect(uriOfRecord({ tnf: 1, type: "T", payload: [4, ...bytes("a.sa")] })).toBeNull();
    expect(uriOfRecord({ tnf: 1, type: "U", payload: [4] })).toBeNull();
    expect(uriOfRecord({ tnf: 1, type: "U", payload: [4, 0x20] })).toBeNull();
    expect(uriOfRecord({ tnf: 1, type: "U", payload: [9, ...bytes("a.sa")] })).toBeNull();
  });
});
