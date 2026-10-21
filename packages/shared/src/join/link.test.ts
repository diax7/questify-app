import { describe, expect, it } from "vitest";
import { JOIN_LINK_HOSTS, joinLink, parseJoinLink } from "#src/join/link";

describe("parseJoinLink", () => {
  it("reads a bare code in any case, trimmed", () => {
    expect(parseJoinLink("  abc234 ")).toBe("ABC234");
    expect(parseJoinLink("ABCD")).toBe("ABCD");
    expect(parseJoinLink("ABCDEFGHJKMN")).toBe("ABCDEFGHJKMN");
  });

  it("reads the code from a join link on a Questify host, in either language", () => {
    for (const host of JOIN_LINK_HOSTS) {
      expect(parseJoinLink(`https://${host}/ar/e/abc234`)).toBe("ABC234");
      expect(parseJoinLink(`https://${host}/en/e/ABC234/`)).toBe("ABC234");
      expect(parseJoinLink(`https://${host}/en/e/ABC234?utm=poster#top`)).toBe("ABC234");
    }
  });

  it("makes links it reads back", () => {
    expect(parseJoinLink(joinLink("ABC234", "ar"))).toBe("ABC234");
    expect(joinLink("ABC234", "en")).toBe("https://questify.sa/en/e/ABC234");
  });

  it("is not a Questify join code otherwise", () => {
    for (const text of [
      "",
      "abc",
      "ABCDEFGHJKMNP",
      "ABC-234",
      "http://questify.sa/ar/e/ABC234",
      "https://questify.sa.evil.test/ar/e/ABC234",
      "https://evil.test/ar/e/ABC234",
      "https://questify.sa/fr/e/ABC234",
      "https://questify.sa/ar/q/ABC234",
      "https://questify.sa/ar/e/ABC234/more",
      "https://questify.sa/x/ar/e/ABC234",
      "https://questify.sa/ar/e/AB",
      "https://user@questify.sa:8443/ar/e/ABC234x!",
      "not a url at all",
    ]) {
      expect(parseJoinLink(text), text).toBeNull();
    }
  });

  it("never throws and answers only a valid code, for any text", () => {
    const alphabet = "AZaz09-_/.:?#@ %ابت\u0000https://questify.sa/ar/e/";
    for (let round = 0; round < 2000; round += 1) {
      const length = (round * 7) % 40;
      let text = "";
      for (let i = 0; i < length; i += 1) {
        text += alphabet[(round * 31 + i * 17) % alphabet.length];
      }
      const code = parseJoinLink(text);
      expect(code === null || /^[A-Z0-9]{4,12}$/.test(code), text).toBe(true);
    }
  });
});
