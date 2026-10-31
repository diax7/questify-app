import { describe, expect, it } from "vitest";
import type { EventView } from "#src/lib/events.ts";
import { featureLookup, previewOf } from "#src/lib/preview.ts";
import type { CategoryView, QuestView } from "#src/lib/quests.ts";
import type { RewardView } from "#src/lib/rewards.ts";

const EVENT: EventView = {
  id: "e1",
  joinCode: "ABC234",
  name: { ar: "ملتقى نجد", en: "Najd Meetup" },
  kind: "physical",
  venue: { ar: "الرياض", en: "Riyadh" },
  venuePin: null,
  venueRadiusM: 1000,
  cityId: null,
  access: "public",
  joinMethods: ["code"],
  timezone: "Asia/Riyadh",
  dayStartHour: 4,
  startsAt: "2030-11-01T06:00:00.000Z",
  endsAt: "2030-11-01T14:00:00.000Z",
  status: "draft",
  statusNow: "draft",
  ranking: true,
  rankingToday: true,
  shareQuests: true,
  meetSomeone: true,
  miniGames: true,
  community: true,
};

const quest = (id: string, over: Partial<QuestView> = {}): QuestView => ({
  id,
  categoryId: "c1",
  type: "scan_qr",
  title: { ar: "مهمة " + id, en: "Quest " + id },
  description: { ar: null, en: null },
  points: 40,
  repeatCap: 1,
  opensAt: null,
  closesAt: null,
  visible: true,
  position: 0,
  config: {},
  verification: [],
  itemId: null,
  place: null,
  pollSentAt: null,
  ...over,
});

const category = (quests: QuestView[], over: Partial<CategoryView> = {}): CategoryView => ({
  id: "c1",
  name: { ar: "الجناح", en: "Hall" },
  position: 0,
  orderMode: "any",
  opensAt: null,
  unlockAfter: null,
  completionBonus: 0,
  refresh: "none",
  hidden: false,
  itemId: null,
  quests,
  ...over,
});

const reward = (id: string): RewardView => ({
  id,
  kind: "item",
  name: { ar: "قبعة", en: "Cap" },
  description: { ar: null, en: null },
  price: 120,
  stock: 5,
  unitsOut: 0,
  stockLeft: 5,
  perPlayerLimit: null,
  opensAt: null,
  closesAt: null,
  section: null,
  tags: { new: false, limited: false },
  lowCodes: false,
});

describe("featureLookup", () => {
  it("reads a switch the API did not send as on, and quest ratings as off", () => {
    const on = featureLookup(EVENT);
    expect(on("shop")).toBe(true);
    expect(on("maps")).toBe(true);
    expect(on("questRatings")).toBe(false);
    expect(on("anythingElse")).toBe(true);
    expect(featureLookup({ ...EVENT, shop: false })("shop")).toBe(false);
  });
});

describe("previewOf", () => {
  const categories = [category([quest("a"), quest("b", { visible: false })])];

  it("shows the event in the chosen language with its quests and rewards", () => {
    const en = previewOf(EVENT, categories, [reward("r1")], "en");
    expect(en).toMatchObject({
      name: "Najd Meetup",
      venue: "Riyadh",
      accent: null,
      rankingCard: true,
      agendaButton: true,
      mapsButton: true,
      mapToggle: true,
    });
    expect(en.tabs.map((entry) => entry.tab)).toEqual([
      "index",
      "quests",
      "scan",
      "rewards",
      "profile",
    ]);
    expect(en.categories).toEqual([
      { id: "c1", name: "Hall", quests: [{ id: "a", title: "Quest a", points: "40" }] },
    ]);
    expect(en.rewards).toEqual([{ id: "r1", name: "Cap", price: "120" }]);
    const ar = previewOf(EVENT, categories, [reward("r1")], "ar");
    expect(ar.name).toBe("ملتقى نجد");
    expect(ar.categories[0]?.name).toBe("الجناح");
    expect(ar.rewards?.[0]?.price).toBe("120");
  });

  it("writes numbers with Western digits in Arabic, with a comma between thousands", () => {
    const big = [category([quest("a", { points: 1250 })])];
    expect(previewOf(EVENT, big, [], "ar").categories[0]?.quests[0]?.points).toBe("1,250");
  });

  it("carries the event's accent", () => {
    const branded = { ...EVENT, branding: { accent: "violet" as const } };
    expect(previewOf(branded, [], [], "en").accent).toBe("violet");
  });

  it("drops the Rewards tab and screen with the shop switch", () => {
    const off = previewOf({ ...EVENT, shop: false }, categories, [reward("r1")], "en");
    expect(off.rewards).toBeNull();
    expect(off.tabs.map((entry) => entry.tab)).toEqual(["index", "quests", "scan", "profile"]);
  });

  it("drops Home's Agenda button and the Maps buttons with their switches", () => {
    const off = previewOf({ ...EVENT, agenda: false, maps: false }, [], [], "en");
    expect(off).toMatchObject({ agendaButton: false, mapsButton: false, mapToggle: false });
  });

  it("drops the ranking card with the ranking switch", () => {
    expect(previewOf({ ...EVENT, ranking: false }, [], [], "en").rankingCard).toBe(false);
  });

  it("hides what players never see: hidden quests and categories, live polls, switched-off types", () => {
    const mixed = [
      category([
        quest("share", { type: "share" }),
        quest("meet", { type: "meet" }),
        quest("game", { type: "game" }),
        quest("poll", { type: "vote", config: { live: true } }),
        quest("vote", { type: "vote", config: {} }),
        quest("flash", { flash: true }),
        quest("plain"),
      ]),
      category([quest("secret")], { id: "c2", hidden: true }),
    ];
    const off = { ...EVENT, shareQuests: false, miniGames: false, flashQuests: false };
    const shown = previewOf(off, mixed, [], "en").categories;
    expect(shown.map((entry) => entry.id)).toEqual(["c1"]);
    expect(shown[0]?.quests.map((entry) => entry.id)).toEqual(["meet", "vote", "plain"]);
  });

  it("leaves out a category whose quests are all switched off", () => {
    const sharing = [category([quest("s", { type: "share" })])];
    expect(previewOf({ ...EVENT, shareQuests: false }, sharing, [], "en").categories).toEqual([]);
  });
});
