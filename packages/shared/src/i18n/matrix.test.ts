import { describe, expect, it } from "vitest";
import { MESSAGES } from "./messages";
import {
  buildMatrix,
  matrixRow,
  matrixSchema,
  shownText,
  type MatrixQuery,
  type StoredText,
} from "./matrix";

const messages = {
  "rewards.redeem": { ar: "استبدل جائزتك", en: "Redeem your prize" },
  "rewards.title": { ar: "الجوائز", en: "Prizes" },
  "quests.title": { ar: "المهام", en: "Quests" },
  "quests.count": { ar: "لديك {count} مهمة", en: "You have {count} quests" },
  "quests.untranslated": { ar: "{count}", en: "Quests done: {count}" },
  "nav.tashkeel": { ar: "التنقّل", en: "Navigation" },
  "marketing.title": { ar: "عروض", en: "Offers" },
  "nav.noEnglish": { ar: "أهلا", en: "{name}" },
} as const;

const all: MatrixQuery = { show: "all", offset: 0, limit: 100 };
const keysOf = (query: Partial<MatrixQuery>, stored: readonly StoredText[] = []): string[] =>
  buildMatrix(messages, stored, { ...all, ...query }).rows.map((row) => row.key);

describe("the translation matrix", () => {
  it("lists every shipped key in key order, with its area", () => {
    const matrix = buildMatrix(messages, [], all);
    expect(matrix.total).toBe(8);
    expect(matrix.rows.map((row) => row.key)).toEqual([
      "marketing.title",
      "nav.noEnglish",
      "nav.tashkeel",
      "quests.count",
      "quests.title",
      "quests.untranslated",
      "rewards.redeem",
      "rewards.title",
    ]);
    expect(matrix.rows[0]?.area).toBe("marketing");
    expect(matrix.areas).toEqual([
      { area: "marketing", count: 1 },
      { area: "nav", count: 2 },
      { area: "quests", count: 3 },
      { area: "rewards", count: 2 },
    ]);
  });

  it("finds a key by its text in either language and lists both languages of the match", () => {
    const [row] = buildMatrix(messages, [], { ...all, q: "redeem" }).rows;
    expect(row?.key).toBe("rewards.redeem");
    expect(row?.shipped).toEqual({ ar: "استبدل جائزتك", en: "Redeem your prize" });
    expect(keysOf({ q: "جائزتك" })).toEqual(["rewards.redeem"]);
    expect(keysOf({ q: "  REWARDS.title " })).toEqual(["rewards.title"]);
  });

  it("finds Arabic text without its marks, and with them", () => {
    expect(keysOf({ q: "التنقل" })).toEqual(["nav.tashkeel"]);
    expect(keysOf({ q: "التنقّل" })).toEqual(["nav.tashkeel"]);
  });

  it("finds the text an admin changed", () => {
    const stored = [{ key: "quests.title", ar: null, en: "Adventures" }];
    expect(keysOf({ q: "adventures" }, stored)).toEqual(["quests.title"]);
    expect(keysOf({ q: "adventures" })).toEqual([]);
  });

  it("narrows to one area and to what was changed", () => {
    const stored = [{ key: "quests.title", ar: "المغامرات", en: null }];
    expect(keysOf({ area: "quests" })).toEqual([
      "quests.count",
      "quests.title",
      "quests.untranslated",
    ]);
    expect(keysOf({ show: "changed" }, stored)).toEqual(["quests.title"]);
    expect(keysOf({ show: "changed", area: "rewards" }, stored)).toEqual([]);
  });

  it("filters the keys whose Arabic or English has no letters of its language", () => {
    expect(keysOf({ show: "missingAr" })).toEqual(["quests.untranslated"]);
    expect(keysOf({ show: "missingEn" })).toEqual(["nav.noEnglish"]);
  });

  it("counts the text an admin saved when deciding what is missing", () => {
    const stored = [{ key: "quests.untranslated", ar: "أنجزت {count}", en: null }];
    expect(keysOf({ show: "missingAr" }, stored)).toEqual([]);
  });

  it("pages the matches and reports the total before paging", () => {
    const page = buildMatrix(messages, [], { ...all, offset: 2, limit: 3 });
    expect(page.total).toBe(8);
    expect(page.rows.map((row) => row.key)).toEqual([
      "nav.tashkeel",
      "quests.count",
      "quests.title",
    ]);
    expect(buildMatrix(messages, [], { ...all, offset: 8 }).rows).toEqual([]);
  });

  it("ignores a stored key the app no longer ships", () => {
    const stored = [{ key: "old.gone", ar: "x", en: "y" }];
    expect(buildMatrix(messages, stored, { ...all, show: "changed" }).total).toBe(0);
  });

  it("marks legal and consent texts as locked", () => {
    expect(matrixRow(messages, "marketing.title").locked).toBe(true);
    expect(matrixRow(messages, "quests.title").locked).toBe(false);
  });

  it("marks a stored text the app ignores because the shipped text changed its placeholders", () => {
    const row = matrixRow(messages, "quests.count", {
      key: "quests.count",
      ar: "لديك مهام",
      en: "You have {count} quests, well done",
    });
    expect(row.stale).toEqual({ ar: true, en: false });
    expect(shownText(row, "ar")).toBe("لديك {count} مهمة");
    expect(shownText(row, "en")).toBe("You have {count} quests, well done");
  });

  it("is a shape the schema accepts, over the real catalog", () => {
    const matrix = buildMatrix(MESSAGES, [], { ...all, q: "redeem" });
    expect(matrix.rows.length).toBeGreaterThan(0);
    expect(matrixSchema.safeParse(matrix).success).toBe(true);
    expect(matrix.areas.reduce((sum, area) => sum + area.count, 0)).toBe(
      Object.keys(MESSAGES).length,
    );
  });
});
