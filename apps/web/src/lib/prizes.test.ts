import { describe, expect, it } from "vitest";
import {
  flaggedNames,
  hasOfficialRules,
  named,
  nextRank,
  nextStep,
  prizeSettingsOf,
  prizeStatusKey,
  rankLabel,
  resultsOf,
  type Place,
  type PrizeSettings,
  type Results,
} from "#src/lib/prizes.ts";

const PLACE: Place = {
  rank: 1,
  enrollmentId: "e1",
  player: { username: "sara", avatar: "fox" },
  score: 300,
  openFlags: 0,
  flagKinds: [],
  prize: null,
  prizeStatus: null,
};

const RESULTS: Results = {
  state: "open",
  rankPrizes: true,
  endsAt: null,
  confirmedAt: null,
  revealedAt: null,
  claimUntil: null,
  defaultClaimUntil: null,
  places: [PLACE],
};

describe("prizes", () => {
  it("reads the answers and refuses anything else", () => {
    expect(prizeSettingsOf({ rankPrizes: true, rules: {}, prizes: [] })).toBeDefined();
    expect(prizeSettingsOf({ rankPrizes: "yes", prizes: [] })).toBeUndefined();
    expect(prizeSettingsOf({ rankPrizes: true })).toBeUndefined();
    expect(prizeSettingsOf(null)).toBeUndefined();
    expect(resultsOf(RESULTS)).toBe(RESULTS);
    expect(resultsOf({ state: "open" })).toBeUndefined();
    expect(resultsOf({ places: [] })).toBeUndefined();
    expect(resultsOf("x")).toBeUndefined();
  });

  it("has official rules with a prize while rank prizes are on, or with the organizer's text", () => {
    const none = { ar: null, en: null };
    const prize = { id: "p1" } as unknown as PrizeSettings["prizes"][number];
    const settings = (change: Partial<PrizeSettings>): PrizeSettings => ({
      rankPrizes: false,
      rules: none,
      prizes: [],
      ...change,
    });
    expect(hasOfficialRules(settings({}))).toBe(false);
    expect(hasOfficialRules(settings({ rankPrizes: true }))).toBe(false);
    expect(hasOfficialRules(settings({ rankPrizes: false, prizes: [prize] }))).toBe(false);
    expect(hasOfficialRules(settings({ rankPrizes: true, prizes: [prize] }))).toBe(true);
    expect(hasOfficialRules(settings({ rules: { ar: null, en: "No bags." } }))).toBe(true);
    expect(hasOfficialRules(settings({ rules: { ar: "لا حقائب", en: null } }))).toBe(true);
    expect(hasOfficialRules(settings({ rules: { ar: "", en: "" } }))).toBe(false);
  });

  it("names in the page's language, else the other", () => {
    expect(named({ ar: "كأس", en: "Cup" }, "ar")).toBe("كأس");
    expect(named({ ar: "كأس", en: "Cup" }, "en")).toBe("Cup");
    expect(named({ ar: null, en: "Cup" }, "ar")).toBe("Cup");
    expect(named({ ar: "كأس", en: null }, "en")).toBe("كأس");
    expect(named({ ar: null, en: null }, "en")).toBe("");
  });

  it("labels one rank or a range", () => {
    expect(rankLabel({ rankFrom: 1, rankTo: 1 })).toEqual({
      key: "prizes.rankOne",
      values: { rank: 1 },
    });
    expect(rankLabel({ rankFrom: 2, rankTo: 5 })).toEqual({
      key: "prizes.rankRange",
      values: { from: 2, to: 5 },
    });
  });

  it("says each prize status", () => {
    expect(prizeStatusKey("reserved")).toBe("results.status.reserved");
    expect(prizeStatusKey("handed_over")).toBe("results.status.handedOver");
    expect(prizeStatusKey("cancelled")).toBe("results.status.cancelled");
    expect(prizeStatusKey("expired")).toBe("results.status.expired");
    expect(prizeStatusKey("other")).toBeNull();
  });

  it("names the flagged players", () => {
    expect(
      flaggedNames(
        [
          PLACE,
          { ...PLACE, openFlags: 2, player: { username: "omar", avatar: "x" } },
          { ...PLACE, openFlags: 1, player: { username: null, avatar: "falcon" } },
        ],
        "en",
      ),
    ).toEqual(["@omar", "Deleted player"]);
  });

  it("offers the owner the next step only", () => {
    expect(nextStep(RESULTS, true)).toBe("confirm");
    expect(nextStep({ ...RESULTS, state: "confirmed" }, true)).toBe("reveal");
    expect(nextStep({ ...RESULTS, state: "revealed" }, true)).toBeNull();
    expect(nextStep({ ...RESULTS, state: "not_ended" }, true)).toBeNull();
    expect(nextStep(RESULTS, false)).toBeNull();
  });

  it("offers the rank after the last prize, up to 100", () => {
    expect(nextRank([])).toBe(1);
    expect(nextRank([{ rankTo: 3 }, { rankTo: 1 }])).toBe(4);
    expect(nextRank([{ rankTo: 100 }])).toBe(100);
  });
});
