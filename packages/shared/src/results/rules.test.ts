import { describe, expect, it } from "vitest";
import { officialRules, type RulesData } from "#src/results/rules";

const DATA: RulesData = {
  rankPrizes: true,
  prizes: [
    { rankFrom: 1, rankTo: 1, name: { ar: "كأس ذهبي", en: "Gold cup" } },
    { rankFrom: 2, rankTo: 4, name: { ar: null, en: "Hoodie" } },
  ],
  organizer: "Najd Events",
  endsAt: new Date("2026-11-05T18:00:00Z"),
  timezone: "Asia/Riyadh",
  claimUntil: null,
  text: { ar: null, en: "Bring your ID." },
};

describe("officialRules", () => {
  it("writes the fixed block in both languages from the data, then the organizer's text", () => {
    const rules = officialRules(DATA);
    expect(rules?.text).toEqual({ ar: null, en: "Bring your ID." });
    expect(rules?.block?.en).toEqual([
      "Questify runs this contest on behalf of the event's organizer, Najd Events, who provides the prizes.",
      "Apple and Google are not sponsors of this contest and are not involved in it in any way.",
      "No purchase or payment is needed to take part or to win.",
      "Winners are the players with the highest final score when the event ends. A tie goes to whoever reached that score first. The organizer's team, event staff, banned players and anyone on the event's exclusion list cannot win.",
      "Number of winners: 4",
      "Rank 1: Gold cup",
      "Ranks 2 to 4: Hoodie",
      "The event ends: Thu, 5 Nov 2026, 21:00 (Riyadh time)",
      "Winners collect their prize at the prize desk before the deadline the organizer announces with the winners. A prize not collected by then is forfeited.",
    ]);
    const arabic = rules?.block?.ar ?? [];
    expect(arabic[0]).toContain("Najd Events");
    expect(arabic[1]).toContain("Apple وGoogle");
    expect(arabic[4]).toBe("عدد الفائزين: 4");
    expect(arabic[5]).toBe("المركز 1: كأس ذهبي");
    expect(arabic[6]).toBe("المراكز 2 إلى 4: Hoodie");
    expect(arabic.join(" ")).not.toMatch(/[٠-٩]/);
  });

  it("names the deadline once the winners are revealed", () => {
    const rules = officialRules({ ...DATA, claimUntil: new Date("2026-11-07T15:00:00Z") });
    expect(rules?.block?.en.at(-1)).toBe(
      "Winners collect their prize at the prize desk by Sat, 7 Nov 2026, 18:00 (Riyadh time). A prize not collected by then is forfeited.",
    );
  });

  it("has no block without prizes or with prizes off, and nothing at all without text either", () => {
    expect(officialRules({ ...DATA, rankPrizes: false })).toEqual({ block: null, text: DATA.text });
    expect(officialRules({ ...DATA, prizes: [] })?.block).toBeNull();
    expect(officialRules({ ...DATA, prizes: [], text: { ar: null, en: null } })).toBeNull();
    expect(officialRules({ ...DATA, rankPrizes: false, text: { ar: "اقرأ", en: null } })).toEqual({
      block: null,
      text: { ar: "اقرأ", en: null },
    });
  });
});
