import { describe, expect, it } from "vitest";
import type { SouvenirRule } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import { souvenirAudienceCopy, souvenirConfirmation } from "#src/lib/souvenir-copy.ts";

const rule: SouvenirRule = {
  id: "b99fb99f-4444-4444-a444-444444444444",
  item: {
    id: "souvenir",
    kind: "frame",
    name: { ar: "تذكار", en: "Souvenir" },
    visualKey: "frame-01",
  },
  audience: "joined",
  categoryId: null,
  rankFrom: null,
  rankTo: null,
  status: "draft",
  targetCount: 2,
  targetIds: [],
  granted: 0,
  waitingForResults: false,
};
describe("souvenir promises", () => {
  it("separates joined membership from finisher requirements in both languages", () => {
    for (const language of ["ar", "en"] as const) {
      const t = translatorFor(language);
      expect(souvenirAudienceCopy(t, rule)).not.toContain(t("souvenir.targetHint"));
      const copy = souvenirConfirmation(t, rule, rule.item.name[language], "");
      expect(copy).toContain(t("souvenir.eligibility"));
      expect(copy).toContain(t("souvenir.promise"));
    }
  });
  it("includes frozen finisher exclusions/category/count and final rank bounds", () => {
    const t = translatorFor("ar");
    expect(souvenirConfirmation(t, { ...rule, audience: "category" }, "تذكار", "التراث")).toContain(
      "التراث",
    );
    expect(souvenirConfirmation(t, { ...rule, audience: "all" }, "تذكار", "")).toContain(
      t("souvenir.targetHint"),
    );
    expect(
      souvenirConfirmation(t, { ...rule, audience: "rank", rankFrom: 4, rankTo: 20 }, "تذكار", ""),
    ).toContain("من 4 إلى 20");
  });
});
