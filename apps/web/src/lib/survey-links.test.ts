import { describe, expect, it } from "vitest";
import { surveyLinkOf, tokenFromHash } from "#src/lib/survey-links.ts";

const TOKEN = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE";

describe("the speaker's link", () => {
  it("puts the token in the fragment of the page in the dashboard's language", () => {
    expect(surveyLinkOf("https://questify.sa", "ar", TOKEN)).toBe(
      `https://questify.sa/ar/r#${TOKEN}`,
    );
    expect(surveyLinkOf("http://localhost:3100", "en", TOKEN)).toBe(
      `http://localhost:3100/en/r#${TOKEN}`,
    );
  });

  it("reads the token back from a fragment with or without its hash sign", () => {
    expect(TOKEN).toHaveLength(43);
    expect(tokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash(TOKEN)).toBe(TOKEN);
  });

  it("reads nothing from an empty, short, long or foreign fragment", () => {
    for (const hash of [
      "",
      "#",
      "#short",
      `#${TOKEN}x`,
      `#${TOKEN.slice(1)}`,
      `#${TOKEN.slice(1)}!`,
    ]) {
      expect(tokenFromHash(hash), hash).toBeUndefined();
    }
  });
});
