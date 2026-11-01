import { readHomeContent, type CountdownCard } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  SLIDE_MS,
  SWIPE_PX,
  countdownRefreshMs,
  countdownView,
  featuredView,
  localIn,
  nextSlide,
  showDots,
  swipeStep,
  tapOutcome,
} from "#src/event/home-content.ts";
import type { QuestsView } from "#src/event/quests-api.ts";
import type { ShopView } from "#src/event/shop-api.ts";

const allOn = () => true;
const QUEST = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("localIn", () => {
  it("uses the screen's language, then the other one, then nothing", () => {
    expect(localIn({ ar: "عربي", en: "English" }, "ar")).toBe("عربي");
    expect(localIn({ ar: "", en: "English" }, "ar")).toBe("English");
    expect(localIn({ ar: "عربي", en: "" }, "en")).toBe("عربي");
    expect(localIn({ ar: "", en: "" }, "en")).toBe("");
  });
});

describe("tapOutcome", () => {
  it("opens the screens whose event switch is on, and nothing when it is off", () => {
    for (const kind of ["agenda", "maps", "shop"] as const) {
      expect(tapOutcome({ type: kind }, allOn)).toEqual({ kind });
      expect(tapOutcome({ type: kind }, (feature) => feature !== kind)).toBeNull();
    }
  });

  it("opens a quest by its id and does nothing for none", () => {
    expect(tapOutcome({ type: "quest", questId: QUEST }, allOn)).toEqual({
      kind: "quest",
      questId: QUEST,
    });
    expect(tapOutcome({ type: "none" }, allOn)).toBeNull();
  });

  it("gives a link with the host the player is asked about", () => {
    expect(tapOutcome({ type: "link", url: "https://Example.com:8443/a?b=1" }, allOn)).toEqual({
      kind: "link",
      url: "https://Example.com:8443/a?b=1",
      host: "example.com",
    });
  });
});

describe("the banner slider", () => {
  it("wraps round in both directions, and a single slide stays put", () => {
    expect(nextSlide(0, 3, 1)).toBe(1);
    expect(nextSlide(2, 3, 1)).toBe(0);
    expect(nextSlide(0, 3, -1)).toBe(2);
    expect(nextSlide(0, 1, 1)).toBe(0);
    expect(nextSlide(0, 0, -1)).toBe(0);
  });

  it("goes forward on a drag towards the start of the line, which is left in English and right in Arabic", () => {
    expect(swipeStep(-(SWIPE_PX + 1), false)).toBe(1);
    expect(swipeStep(SWIPE_PX + 1, false)).toBe(-1);
    expect(swipeStep(SWIPE_PX + 1, true)).toBe(1);
    expect(swipeStep(-(SWIPE_PX + 1), true)).toBe(-1);
  });

  it("ignores a short drag", () => {
    expect(swipeStep(SWIPE_PX - 1, false)).toBe(0);
    expect(swipeStep(-(SWIPE_PX - 1), true)).toBe(0);
    expect(swipeStep(0, false)).toBe(0);
  });

  it("shows dots for two slides or more and none for one", () => {
    expect(showDots(0)).toBe(false);
    expect(showDots(1)).toBe(false);
    expect(showDots(2)).toBe(true);
    expect(showDots(5)).toBe(true);
    expect(SLIDE_MS).toBeGreaterThanOrEqual(3000);
  });
});

const card = (changes: Record<string, unknown> = {}): CountdownCard => {
  const read = readHomeContent({
    cards: [
      {
        id: "bbbbbb22",
        kind: "countdown",
        label: { ar: "الأبواب", en: "Doors" },
        at: "2030-01-01T09:00:00.000Z",
        atZero: "message",
        message: { ar: "", en: "Open now" },
        ...changes,
      },
    ],
  }).cards[0];
  if (read?.kind !== "countdown") {
    throw new Error("The test card is not a countdown.");
  }
  return read;
};
const AT = Date.parse("2030-01-01T09:00:00.000Z");

describe("countdownView", () => {
  it("counts down in the largest whole unit, in the screen's language", () => {
    expect(countdownView(card(), AT - 3 * 86_400_000, "en")).toEqual({
      kind: "counting",
      label: "Doors",
      span: "3 days",
    });
    expect(countdownView(card(), AT - 2 * 3_600_000, "ar")).toEqual({
      kind: "counting",
      label: "الأبواب",
      span: "ساعتين",
    });
  });

  it("has no span under a minute but still counts", () => {
    expect(countdownView(card(), AT - 30_000, "en")).toMatchObject({
      kind: "counting",
      span: null,
    });
  });

  it("shows its message at zero when told to, falling back to the other language", () => {
    expect(countdownView(card(), AT, "en")).toEqual({
      kind: "message",
      label: "Doors",
      message: "Open now",
    });
    expect(countdownView(card(), AT + 1, "ar")).toMatchObject({ message: "Open now" });
  });

  it("disappears at zero when told to hide", () => {
    expect(countdownView(card({ atZero: "hide" }), AT, "en")).toEqual({ kind: "hidden" });
    expect(countdownView(card({ atZero: "hide" }), AT - 1, "en").kind).toBe("counting");
  });

  it("asks to be redrawn within a minute while counting and never once it is over", () => {
    expect(countdownRefreshMs(card(), AT - 10 * 3_600_000)).toBe(30_000);
    expect(countdownRefreshMs(card(), AT - 5000)).toBe(6000);
    expect(countdownRefreshMs(card(), AT)).toBeNull();
  });
});

const quests = (state: string, id = QUEST): QuestsView =>
  ({
    event: { statusNow: "live", timezone: "Asia/Riyadh" },
    categories: [
      {
        id: "c1",
        name: { ar: null, en: "C" },
        quests: [{ id, title: { ar: null, en: "Find it" }, points: 50, state }],
      },
    ],
  }) as unknown as QuestsView;
const shop = (stockLeft: number): ShopView =>
  ({
    rewards: [{ id: QUEST, name: { ar: null, en: "Mug" }, price: 120, stockLeft }],
  }) as unknown as ShopView;

describe("featuredView", () => {
  it("finds the quest in the player's own list", () => {
    expect(featuredView({ kind: "quest", id: QUEST }, quests("open"), undefined)).toEqual({
      kind: "quest",
      id: QUEST,
      title: { ar: null, en: "Find it" },
      points: 50,
    });
  });

  it("draws nothing for a finished quest, a quest that is not in the list, or no list yet", () => {
    expect(featuredView({ kind: "quest", id: QUEST }, quests("done"), undefined)).toBeNull();
    expect(featuredView({ kind: "quest", id: "other" }, quests("open"), undefined)).toBeNull();
    expect(featuredView({ kind: "quest", id: QUEST }, undefined, undefined)).toBeNull();
  });

  it("finds a reward in stock, and draws nothing once it is sold out or missing", () => {
    expect(featuredView({ kind: "reward", id: QUEST }, undefined, shop(3))).toMatchObject({
      kind: "reward",
      points: 120,
    });
    expect(featuredView({ kind: "reward", id: QUEST }, undefined, shop(0))).toBeNull();
    expect(featuredView({ kind: "reward", id: QUEST }, undefined, undefined)).toBeNull();
  });

  it("does not look a quest id up among rewards or the other way round", () => {
    expect(featuredView({ kind: "reward", id: QUEST }, quests("open"), undefined)).toBeNull();
    expect(featuredView({ kind: "quest", id: QUEST }, undefined, shop(3))).toBeNull();
  });
});
