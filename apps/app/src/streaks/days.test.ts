import { MESSAGES, NO_OVERRIDES, createTranslator, type Language } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { daysLabel } from "#src/streaks/days.ts";

const translate = createTranslator(MESSAGES, NO_OVERRIDES);
const tIn =
  (language: Language) =>
  (key: Parameters<typeof translate>[0], params?: Record<string, string | number>) =>
    translate(key, language, params);

describe("daysLabel", () => {
  it.each([
    [0, "0 days"],
    [1, "1 day"],
    [2, "2 days"],
    [14, "14 days"],
    [1200, "1,200 days"],
  ])("counts %i in English", (count, text) => {
    expect(daysLabel(tIn("en"), count, "en")).toBe(text);
  });

  it.each([
    [0, "0 أيام"],
    [1, "يوم واحد"],
    [2, "يومين"],
    [3, "3 أيام"],
    [10, "10 أيام"],
    [11, "11 يومًا"],
    [14, "14 يومًا"],
    [30, "30 يومًا"],
    [100, "100 يومًا"],
    [102, "102 يومًا"],
    [103, "103 أيام"],
    [365, "365 يومًا"],
  ])("counts %i in Arabic with Western digits", (count, text) => {
    expect(daysLabel(tIn("ar"), count, "ar")).toBe(text);
  });

  it("keeps the nominative pair for a subject in Arabic only", () => {
    expect(daysLabel(tIn("ar"), 2, "ar", "subject")).toBe("يومان");
    expect(daysLabel(tIn("ar"), 5, "ar", "subject")).toBe("5 أيام");
    expect(daysLabel(tIn("en"), 2, "en", "subject")).toBe("2 days");
  });
});
