import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";

/** The event currency's icon and the memory game's card are a gem by choice, not Questify's currency (ADR-768, Q-725). */
const ALLOWED = new Set(["terms.icon.gem", "games.picture.gem"]);

describe("levels only (ADR-760)", () => {
  const rows = Object.entries(MESSAGES).filter(([key]) => !ALLOWED.has(key));

  it("no English message speaks of gems", () => {
    expect(rows.filter(([, text]) => /\bgems?\b/i.test(text.en)).map(([key]) => key)).toEqual([]);
  });

  it("no Arabic message speaks of gems", () => {
    expect(rows.filter(([, text]) => /جوهر|جواهر/.test(text.ar)).map(([key]) => key)).toEqual([]);
  });

  it("no message key is about gems, apart from the two kept ones", () => {
    expect(rows.map(([key]) => key).filter((key) => /(^|\.)gem/i.test(key))).toEqual([]);
  });
});
