import {
  DEFAULT_TERMS,
  MESSAGES,
  createTranslator,
  formatEventTime,
  type Language,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import { paidText } from "#src/event/amount.ts";
import {
  boostKey,
  boostLine,
  flashKey,
  flashLine,
  liveBoostsOf,
  liveFlashOf,
  nextDrop,
} from "#src/event/flash-boost.ts";
import { liveStateOf } from "#src/event/polls.ts";
import { readQuests } from "#src/event/quests-api.ts";

const translate = createTranslator(MESSAGES);
const tIn =
  (language: Language) =>
  (key: keyof typeof MESSAGES, params?: Readonly<Record<string, string | number>>) =>
    translate(key, language, params);
const ZONE = "Asia/Riyadh";
const ENDS = "2030-11-01T10:30:00.000Z";
const FLASH = { questId: "q1", title: { ar: "الصقر", en: "Falcon" }, closesAt: ENDS };
const BOOST = {
  boostId: "b1",
  categoryId: "c1",
  category: { ar: "المسرح", en: "Stage" },
  multiplier: 2,
  endsAt: ENDS,
};

describe("a flash quest's and a boost's lines (T-307)", () => {
  it("says when a flash quest ends, in the event's zone, and nothing for another quest", () => {
    const time = formatEventTime(new Date(ENDS), ZONE, "en");
    expect(flashLine({ flash: { closesAt: ENDS } }, tIn("en"), "en", ZONE)).toBe(`Ends ${time}`);
    expect(flashLine({ flash: null }, tIn("en"), "en", ZONE)).toBeNull();
    expect(flashLine({ flash: { closesAt: ENDS } }, tIn("ar"), "ar", ZONE)).toBe(
      `تنتهي ${formatEventTime(new Date(ENDS), ZONE, "ar")}`,
    );
  });

  it("says double points until the boost's end, and nothing without one", () => {
    const time = formatEventTime(new Date(ENDS), ZONE, "en");
    expect(boostLine({ multiplier: 2, endsAt: ENDS }, tIn("en"), "en", ZONE)).toBe(
      `Double points until ${time}`,
    );
    expect(boostLine(null, tIn("en"), "en", ZONE)).toBeNull();
  });

  it("keeps the ×2 badge an isolated run in Arabic, so RTL never reorders it", () => {
    expect(tIn("ar")("quests.boost.badge")).toBe("⁨×2⁩");
    expect(tIn("en")("quests.boost.badge")).toBe("×2");
  });

  it("puts Double points! first in what a boosted play paid, and nothing more for a plain one", () => {
    const paid = { points: 20, bonus: null, item: null };
    expect(paidText(tIn("en"), DEFAULT_TERMS, "en", { ...paid, boost: { multiplier: 2 } })).toBe(
      `Double points! ${paidText(tIn("en"), DEFAULT_TERMS, "en", paid)}`,
    );
    expect(paidText(tIn("en"), DEFAULT_TERMS, "en", { ...paid, boost: null })).toBe(
      paidText(tIn("en"), DEFAULT_TERMS, "en", paid),
    );
  });
});

const quest = (fields: Record<string, unknown>) => ({
  id: "q1",
  type: "scan_qr",
  title: { ar: null, en: "Quest" },
  description: { ar: null, en: null },
  opensAt: null,
  closesAt: null,
  state: "open",
  points: 10,
  repeatCap: 1,
  done: 0,
  earned: 0,
  ...fields,
});
const read = (fields: Record<string, unknown>, category: Record<string, unknown> = {}) =>
  readQuests({
    event: { statusNow: "live", timezone: ZONE },
    categories: [
      { id: "c1", name: { ar: null, en: "Stage" }, quests: [quest(fields)], ...category },
    ],
  })?.categories[0];

describe("the quests read's flash and boost (T-307)", () => {
  it("reads a flash quest's end and a running boost, on the quest and its category", () => {
    const boost = { multiplier: 2, endsAt: ENDS };
    const category = read({ flash: { closesAt: ENDS }, boost }, { boost });
    expect(category?.boost).toEqual(boost);
    expect(category?.quests[0]).toMatchObject({ flash: { closesAt: ENDS }, boost });
  });

  it("reads none from an older API or a malformed field, so the quest still shows", () => {
    const category = read({ flash: { closesAt: 5 }, boost: { multiplier: "2" } });
    expect(category?.boost).toBeNull();
    expect(category?.quests[0]).toMatchObject({ flash: null, boost: null });
    expect(read({})?.quests[0]).toMatchObject({ flash: null, boost: null });
  });
});

describe("the live cards (T-307)", () => {
  it("reads flash quests and boosts, dropping a malformed one, and none from an older API", () => {
    expect(liveFlashOf([FLASH, { questId: "q2" }])).toEqual([FLASH]);
    expect(liveBoostsOf([BOOST, { ...BOOST, multiplier: "2" }])).toEqual([BOOST]);
    expect(liveFlashOf(undefined)).toEqual([]);
    expect(liveBoostsOf(null)).toEqual([]);
    expect(liveStateOf({ polls: [], closed: [], community: null })).toMatchObject({
      flash: [],
      boosts: [],
    });
    expect(
      liveStateOf({ polls: [], closed: [], community: null, flash: [FLASH], boosts: [BOOST] }),
    ).toMatchObject({ flash: [FLASH], boosts: [BOOST] });
  });

  it("shows each card once, flash quests first, by its own key", () => {
    const live = { flash: [FLASH], boosts: [BOOST] };
    expect(nextDrop(live, [])).toEqual({ kind: "flash", key: "flash:q1", flash: FLASH });
    expect(nextDrop(live, [flashKey("q1")])).toEqual({
      kind: "boost",
      key: "boost:b1",
      boost: BOOST,
    });
    expect(nextDrop(live, [flashKey("q1"), boostKey("b1")])).toBeUndefined();
    expect(nextDrop({ flash: [], boosts: [] }, [])).toBeUndefined();
  });
});
