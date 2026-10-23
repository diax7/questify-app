import { describe, expect, it } from "vitest";
import { MEET_CODE_PREFIX, meetCodeOf, meetTokenOf } from "#src/quests/meet-code";

const TOKEN = "AbCdEfGhIjKlMnOpQr_-12";

describe("meet codes", () => {
  it("round-trips a token through its code", () => {
    expect(meetCodeOf(TOKEN)).toBe(`questify/meet/v1/${TOKEN}`);
    expect(meetTokenOf(meetCodeOf(TOKEN))).toBe(TOKEN);
    expect(MEET_CODE_PREFIX).toBe("questify/meet/v1/");
  });

  it("refuses anything that is not exactly a meet code", () => {
    for (const text of [
      "",
      TOKEN,
      "questify/meet/v1/",
      `questify/meet/v2/${TOKEN}`,
      `QUESTIFY/meet/v1/${TOKEN}`,
      `xquestify/meet/v1/${TOKEN}`,
      `questify/meet/v1/${TOKEN}x`,
      `questify/meet/v1/${TOKEN.slice(1)}`,
      `questify/meet/v1/${TOKEN.slice(1)}=`,
      `questify/meet/v1/${TOKEN.slice(1)}+`,
      `questify/meet/v1/${TOKEN} `,
      `https://questify.nafes.com/q/${TOKEN}`,
    ]) {
      expect(meetTokenOf(text), text).toBeUndefined();
    }
  });
});
