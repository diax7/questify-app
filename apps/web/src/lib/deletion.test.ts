import { describe, expect, it } from "vitest";
import {
  challengeTokenOf,
  deletionTokenOf,
  pendingOf,
  textIn,
  verifyAnswerOf,
} from "#src/lib/deletion.ts";

describe("the deletion page's answers", () => {
  it("reads the waiting prizes and leaves malformed ones out", () => {
    expect(
      pendingOf([
        {
          redemptionId: "r1",
          event: { ar: "مهرجان", en: "Fest" },
          item: { en: "Spa" },
          rankPrize: true,
        },
        { event: {} },
        "x",
      ]),
    ).toEqual([
      {
        redemptionId: "r1",
        event: { ar: "مهرجان", en: "Fest" },
        item: { ar: null, en: "Spa" },
        rankPrize: true,
      },
    ]);
    expect(pendingOf(undefined)).toEqual([]);
  });

  it("names a prize in the page's language, else the other one", () => {
    expect(textIn({ ar: "مهرجان", en: "Fest" }, "ar")).toBe("مهرجان");
    expect(textIn({ ar: null, en: "Spa" }, "ar")).toBe("Spa");
    expect(textIn({ ar: "سبا", en: null }, "en")).toBe("سبا");
    expect(textIn({ ar: null, en: null }, "en")).toBe("");
  });

  it("finds the deletion token", () => {
    expect(deletionTokenOf({ deletionToken: "d1" })).toBe("d1");
    expect(deletionTokenOf({ deletionToken: 3 })).toBeUndefined();
    expect(deletionTokenOf(null)).toBeUndefined();
  });

  it("reads the challenge token as text, empty when missing", () => {
    expect(challengeTokenOf({ challengeToken: "c1" })).toBe("c1");
    expect(challengeTokenOf({ challengeToken: 7 })).toBe("7");
    expect(challengeTokenOf({})).toBe("");
    expect(challengeTokenOf(null)).toBe("");
    expect(challengeTokenOf("c1")).toBe("");
  });

  it("reads a verify answer, missing parts empty", () => {
    expect(
      verifyAnswerOf({ deletionToken: "d1", pending: [{ redemptionId: "r1", rankPrize: true }] }),
    ).toEqual({
      deletionToken: "d1",
      pending: [
        {
          redemptionId: "r1",
          event: { ar: null, en: null },
          item: { ar: null, en: null },
          rankPrize: true,
        },
      ],
    });
    expect(verifyAnswerOf({ deletionToken: 3 })).toEqual({ deletionToken: "", pending: [] });
    expect(verifyAnswerOf(undefined)).toEqual({ deletionToken: "", pending: [] });
  });
});
