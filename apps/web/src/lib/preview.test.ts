import {
  DEFAULT_LOOKS,
  DEFAULT_TERMS,
  INFO_KEYS,
  NO_EVENT_TEXTS,
  readEventTerms,
  readEventTexts,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { EventView } from "#src/lib/events.ts";
import { featureLookup, phoneTranslator, previewOf } from "#src/lib/preview.ts";
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

const blocks = (event: EventView) =>
  previewOf(event, [], [], "en").homeBlocks.map((entry) => entry.block);

describe("previewOf", () => {
  const categories = [category([quest("a"), quest("b", { visible: false })])];

  it("shows the event in the chosen language with its quests and rewards", () => {
    const en = previewOf(EVENT, categories, [reward("r1")], "en");
    expect(en).toMatchObject({
      name: "Najd Meetup",
      venue: "Riyadh",
      accent: null,
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

  it("lists Home's blocks in the default order, and drops the ranking and goal with their switches", () => {
    expect(blocks(EVENT)).toEqual([
      "countdown",
      "standing",
      "streak",
      "announcements",
      "sponsors",
      "prizes",
      "live",
      "goal",
      "ranking",
      "upNext",
      "links",
    ]);
    expect(blocks({ ...EVENT, ranking: false })).not.toContain("ranking");
    expect(blocks({ ...EVENT, shop: false })).not.toContain("goal");
  });

  it("follows the event's layout: the bar and Home in its order, without what it hides", () => {
    const layout = {
      bar: { order: ["rewards", "index", "scan", "quests", "profile"], hidden: ["quests"] },
      home: {
        order: ["ranking", "countdown", "standing", "streak", "announcements", "sponsors"],
        hidden: ["streak", "sponsors", "live"],
      },
    };
    const preview = previewOf({ ...EVENT, layout }, categories, [reward("r1")], "en");
    expect(preview.tabs.map((entry) => entry.tab)).toEqual(["rewards", "index", "scan", "profile"]);
    expect(preview.homeBlocks.map((entry) => entry.block).slice(0, 4)).toEqual([
      "ranking",
      "countdown",
      "standing",
      "announcements",
    ]);
    expect(preview.homeBlocks.map((entry) => entry.block)).not.toContain("streak");
    expect(preview.rewards).toHaveLength(1);
  });

  it("keeps the Rewards screen out when the layout hides the tab, and a hidden switch out whatever the layout says", () => {
    const hidesRewards = {
      bar: { order: ["index", "quests", "scan", "rewards", "profile"], hidden: ["rewards"] },
    };
    const hidden = previewOf({ ...EVENT, layout: hidesRewards }, categories, [reward("r1")], "en");
    expect(hidden.rewards).toBeNull();
    const showsRewards = {
      bar: { order: ["rewards", "index", "scan", "quests", "profile"], hidden: [] },
    };
    const off = previewOf({ ...EVENT, shop: false, layout: showsRewards }, categories, [], "en");
    expect(off.tabs.map((entry) => entry.tab)).not.toContain("rewards");
    expect(off.rewards).toBeNull();
  });

  it("drops Home's Agenda and Maps buttons with the announcements block", () => {
    const layout = { home: { order: [], hidden: ["announcements"] } };
    expect(previewOf({ ...EVENT, layout }, [], [], "en")).toMatchObject({
      agendaButton: false,
      mapsButton: false,
    });
  });

  it("reads a layout the API sent damaged as Questify's own", () => {
    expect(
      previewOf({ ...EVENT, layout: "broken" }, [], [], "en").tabs.map((entry) => entry.tab),
    ).toEqual(["index", "quests", "scan", "rewards", "profile"]);
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

describe("previewOf and the organizer's own Home blocks (T-610)", () => {
  const QUEST = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const empty = { ar: "", en: "" };
  const content = {
    banner: [
      { title: { ar: "أهلًا", en: "Welcome" }, subtitle: empty, action: { type: "none" } },
      { title: { ar: "", en: "Day two" }, subtitle: empty, action: { type: "agenda" } },
    ],
    quickLinks: [
      { label: { ar: "", en: "Agenda" }, icon: "calendar", action: { type: "agenda" } },
      { label: { ar: "", en: "Shop" }, icon: "gift", action: { type: "shop" } },
    ],
    featured: { kind: "quest", id: QUEST },
    cards: [
      { id: "aaaaaa11", kind: "text", title: empty, body: { ar: "", en: "Doors open" } },
      {
        id: "bbbbbb22",
        kind: "countdown",
        label: { ar: "", en: "Doors" },
        at: "2030-11-01T06:00:00.000Z",
        atZero: "hide",
        message: empty,
      },
    ],
  };
  const home = (hidden: string[] = ["podium"]) => ({
    bar: { order: ["index", "quests", "scan", "rewards", "profile"], hidden: [] },
    home: {
      order: [
        "banner",
        "countdown",
        "standing",
        "streak",
        "announcements",
        "sponsors",
        "prizes",
        "live",
        "goal",
        "featured",
        "ranking",
        "podium",
        "upNext",
        "quickLinks",
        "links",
        "card:aaaaaa11",
        "card:bbbbbb22",
      ],
      hidden,
    },
    content,
  });
  const preview = (event: Partial<EventView> = {}, hidden?: string[]) =>
    previewOf({ ...EVENT, layout: home(hidden), ...event }, [category([quest(QUEST)])], [], "en");
  const lines = (key: string, event: Partial<EventView> = {}, hidden?: string[]) =>
    preview(event, hidden).homeBlocks.find((entry) => entry.block === key)?.lines;

  it("draws a block that holds words by what it holds, and a card by its own lines", () => {
    expect(lines("banner")).toEqual(["Welcome", "Day two"]);
    expect(lines("quickLinks")).toEqual(["Agenda", "Shop"]);
    expect(lines("featured")).toEqual([`Quest ${QUEST}`]);
    expect(lines("card:aaaaaa11")).toEqual(["Doors open"]);
    expect(lines("card:bbbbbb22")?.[0]).toBe("Doors");
    expect(lines("card:bbbbbb22")?.[1]).toMatch(/2030/);
    expect(preview().homeBlocks.find((entry) => entry.block === "card:aaaaaa11")?.title).toBeNull();
  });

  it("uses the page's language and falls back to the other one", () => {
    const arabic = previewOf({ ...EVENT, layout: home() }, [], [], "ar");
    expect(arabic.homeBlocks.find((entry) => entry.block === "banner")?.lines).toEqual([
      "أهلًا",
      "Day two",
    ]);
  });

  it("leaves out a block with nothing to draw, as the app does", () => {
    const bare = previewOf(
      {
        ...EVENT,
        layout: {
          ...home(),
          content: { ...content, banner: [], quickLinks: [], featured: null, cards: [] },
        },
      },
      [],
      [],
      "en",
    );
    const keys = bare.homeBlocks.map((entry) => entry.block);
    expect(keys).not.toContain("banner");
    expect(keys).not.toContain("quickLinks");
    expect(keys).not.toContain("featured");
    expect(keys.some((key) => key.startsWith("card:"))).toBe(false);
    const missing = previewOf({ ...EVENT, layout: home() }, [], [], "en");
    expect(missing.homeBlocks.map((entry) => entry.block)).not.toContain("featured");
  });

  it("leaves out a quick link to a screen whose switch is off", () => {
    expect(lines("quickLinks", { shop: false })).toEqual(["Agenda"]);
    expect(lines("quickLinks", { shop: false, agenda: false })).toBeUndefined();
  });

  it("draws the podium only when it is shown and the ranking is on", () => {
    expect(preview().homeBlocks.map((entry) => entry.block)).not.toContain("podium");
    expect(preview({}, []).homeBlocks.map((entry) => entry.block)).toContain("podium");
    expect(preview({ ranking: false }, []).homeBlocks.map((entry) => entry.block)).not.toContain(
      "podium",
    );
  });

  it("keeps a hidden block's words off the preview", () => {
    const keys = preview({}, ["podium", "banner", "card:aaaaaa11"]).homeBlocks.map(
      (entry) => entry.block,
    );
    expect(keys).not.toContain("banner");
    expect(keys).not.toContain("card:aaaaaa11");
    expect(keys).toContain("card:bbbbbb22");
  });
});

const withLooks = (looks: unknown) => previewOf({ ...EVENT, layout: { looks } }, [], [], "en");

describe("previewOf and how the screens are drawn (T-611)", () => {
  it("draws an event with no looks as the screens have always been drawn", () => {
    expect(previewOf(EVENT, [], [], "en").looks).toEqual(DEFAULT_LOOKS);
  });

  it("carries the draft's looks for the ranking, Quests and Rewards screens", () => {
    const looks = {
      ranking: { layout: "podium", scores: "rank_only" },
      quests: "grid",
      shop: "grid",
    };
    expect(withLooks(looks).looks).toEqual(looks);
  });

  it("reads looks the API sent damaged as the default layouts and hides the scores", () => {
    const read = withLooks({ ranking: { layout: "carousel", scores: "top3" }, quests: 4 }).looks;
    expect(read).toEqual({ ...DEFAULT_LOOKS, ranking: { layout: "list", scores: "rank_only" } });
  });

  it("gives the ranking screen example players in the page's language, and none while the ranking is off", () => {
    const rows = previewOf(EVENT, [], [], "ar").ranking;
    expect(rows).toHaveLength(8);
    expect(rows?.[0]).toEqual({ rank: 1, username: "sara", score: "1,240" });
    expect(previewOf({ ...EVENT, ranking: false }, [], [], "en").ranking).toBeNull();
  });
});

const words = (en: string, ar = "") => ({ ar, en });

describe("the event info page and the extra page in the preview (T-613)", () => {
  const written = {
    about: words("A day of games.", "يوم من الألعاب."),
    faq: [
      { question: words("Is parking free?"), answer: words("Yes") },
      { question: words("Where?"), answer: words("Hall 2") },
    ],
    contacts: [{ label: words("Front desk"), kind: "phone", value: "0501234567" }],
    page: {
      title: words("Venue rules"),
      blocks: [
        { kind: "heading", text: words("Before you come") },
        { kind: "list", items: words("ID card\nTicket") },
      ],
    },
  };
  const withInfo = (
    layout: Record<string, unknown> = {},
    event: Partial<EventView> = {},
    hasRules = true,
  ) =>
    previewOf(
      { ...EVENT, ...event, layout: { content: written, ...layout } },
      [],
      [],
      "en",
      hasRules,
    );
  const sections = (preview: ReturnType<typeof withInfo>) => preview.info.map((row) => row.section);

  it("draws the sections the page has, in the default order, the schedule link off", () => {
    expect(sections(withInfo())).toEqual(["about", "venue", "when", "faq", "contacts", "rules"]);
  });

  it("follows the order the organizer set and leaves out what is hidden", () => {
    const order = ["rules", "faq", ...INFO_KEYS.filter((key) => key !== "rules" && key !== "faq")];
    const preview = withInfo({ info: { order, hidden: ["when", "schedule"] } });
    expect(sections(preview)).toEqual(["rules", "faq", "about", "venue", "contacts"]);
  });

  it("holds the lines each section draws", () => {
    const rows = Object.fromEntries(withInfo().info.map((row) => [row.section, row.lines]));
    expect(rows["about"]).toEqual(["A day of games."]);
    expect(rows["venue"]).toEqual(["Riyadh"]);
    expect(rows["faq"]).toEqual(["Is parking free?", "Where?"]);
    expect(rows["contacts"]).toEqual(["Front desk"]);
  });

  it("leaves out a section with nothing to say, as the app does", () => {
    const empty = withInfo({ content: { about: words(""), faq: [], contacts: [] } });
    expect(sections(empty)).toEqual(["venue", "when", "rules"]);
  });

  it("draws the official rules row only when the event has rules, as the app does", () => {
    expect(sections(withInfo())).toContain("rules");
    expect(sections(withInfo({}, {}, false))).toEqual([
      "about",
      "venue",
      "when",
      "faq",
      "contacts",
    ]);
  });

  it("draws the schedule link only while the agenda is on", () => {
    const shown = { info: { order: INFO_KEYS, hidden: [] } };
    expect(sections(withInfo(shown, { agenda: true }))).toContain("schedule");
    expect(sections(withInfo(shown, { agenda: false }))).not.toContain("schedule");
  });

  it("draws the extra page with its title and parts, and its link on Home", () => {
    const preview = withInfo();
    expect(preview.page).toEqual({
      title: "Venue rules",
      lines: ["Before you come", "ID card", "Ticket"],
    });
    expect(preview.homeBlocks.find((entry) => entry.block === "page")?.lines).toEqual([
      "Venue rules",
    ]);
  });

  it("draws no page, and no link to it, while its Home link is hidden or the page is empty", () => {
    const hidden = withInfo({
      home: { order: ["page", "standing", "prizes", "links"], hidden: ["page"] },
    });
    expect(hidden.page).toBeNull();
    expect(hidden.homeBlocks.some((entry) => entry.block === "page")).toBe(false);
    expect(withInfo({ content: { page: null } }).page).toBeNull();
    const untitled = { page: { title: words(""), blocks: written.page.blocks } };
    expect(withInfo({ content: untitled }).page).toBeNull();
  });
});

describe("the event's renamed labels in the preview (T-614)", () => {
  const texts = { ar: { "nav.rewards": "الهدايا" }, en: { "nav.rewards": "Prizes" } };

  it("carries the renamed labels, and none for an event that renamed none", () => {
    expect(previewOf({ ...EVENT, texts }, [], [], "en").texts).toEqual(texts);
    expect(previewOf(EVENT, [], [], "en").texts).toEqual({ ar: {}, en: {} });
  });

  it("reads labels the API sent damaged as none, keeping the usable ones", () => {
    const damaged = {
      ...EVENT,
      texts: { en: { "nav.rewards": "Prizes", "legal.x": "y", "nav.scan": 5 } },
    };
    expect(previewOf(damaged, [], [], "en").texts).toEqual({
      ar: {},
      en: { "nav.rewards": "Prizes" },
    });
    expect(previewOf({ ...EVENT, texts: "damaged" }, [], [], "en").texts).toEqual({
      ar: {},
      en: {},
    });
  });
});

describe("the phone preview's translator (T-614)", () => {
  const terms = readEventTerms({
    quest: { ar: { one: "مغامرة", many: "مغامرات" }, en: { one: "mission", many: "missions" } },
  });
  const texts = readEventTexts({
    ar: { "nav.quests": "{questMany} اليوم" },
    en: { "nav.quests": "Daily {questCap}", "nav.rewards": "Prizes" },
  });

  it("fills the event's word into a renamed label that kept its placeholder", () => {
    expect(phoneTranslator("en", terms, texts)("nav.quests")).toBe("Daily Missions");
    expect(phoneTranslator("ar", terms, texts)("nav.quests")).toBe("مغامرات اليوم");
  });

  it("shows a renamed label that dropped the placeholder as written", () => {
    expect(phoneTranslator("en", terms, texts)("nav.rewards")).toBe("Prizes");
  });

  it("fills the event's word into Questify's text for a label the event did not rename", () => {
    expect(phoneTranslator("en", terms, NO_EVENT_TEXTS)("nav.quests")).toBe("Missions");
    expect(phoneTranslator("en", DEFAULT_TERMS, texts)("nav.quests")).toBe("Daily Quests");
  });

  it("lets a value the call passes win over the event's word", () => {
    expect(phoneTranslator("en", terms, texts)("nav.quests", { questCap: "Tasks" })).toBe(
      "Daily Tasks",
    );
  });
});
