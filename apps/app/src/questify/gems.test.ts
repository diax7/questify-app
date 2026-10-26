import { describe, expect, it } from "vitest";
import { MESSAGES, NO_OVERRIDES, createTranslator, type Language } from "@questify/shared";
import { gemsLabel } from "#src/questify/gems.ts";

const translate = createTranslator(MESSAGES, NO_OVERRIDES);
const tIn =
  (language: Language) =>
  (key: Parameters<typeof translate>[0], params?: Record<string, string | number>) =>
    translate(key, language, params);

describe("gemsLabel", () => {
  it.each([
    [0, "0 gems"],
    [1, "1 gem"],
    [2, "2 gems"],
    [25, "25 gems"],
    [1200, "1,200 gems"],
  ])("counts %i in English", (count, text) => {
    expect(gemsLabel(tIn("en"), count, "en")).toBe(text);
  });

  it.each([
    [0, "0 جواهر"],
    [1, "جوهرة واحدة"],
    [2, "جوهرتين"],
    [3, "3 جواهر"],
    [10, "10 جواهر"],
    [11, "11 جوهرة"],
    [25, "25 جوهرة"],
    [99, "99 جوهرة"],
    [100, "100 جوهرة"],
    [102, "102 جوهرة"],
    [103, "103 جواهر"],
    [1200, "1,200 جوهرة"],
  ])("counts %i in Arabic with Western digits", (count, text) => {
    expect(gemsLabel(tIn("ar"), count, "ar")).toBe(text);
  });

  it("keeps the nominative pair for a subject in Arabic only", () => {
    expect(gemsLabel(tIn("ar"), 2, "ar", "subject")).toBe("جوهرتان");
    expect(gemsLabel(tIn("ar"), 5, "ar", "subject")).toBe("5 جواهر");
    expect(gemsLabel(tIn("en"), 2, "en", "subject")).toBe("2 gems");
  });
});
