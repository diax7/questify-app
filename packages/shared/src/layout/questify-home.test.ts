import { describe, expect, it } from "vitest";
import { homeLayoutDocSchema } from "#src/catalog/catalog";
import { composeConfig } from "#src/config/compose";
import { readPlatformSettings } from "#src/config/read";
import { REGISTRIES } from "#src/config/registry";
import { parseComposedConfig } from "#src/config/validate";
import {
  DEFAULT_COMPOSED_QUESTIFY_HOME,
  DEFAULT_QUESTIFY_HOME,
  QUESTIFY_HOME_BLOCKS,
  QUESTIFY_HOME_KEYS,
  QUESTIFY_HOME_PROTECTED,
  checkQuestifyHome,
  composedQuestifyHomeOf,
  readComposedQuestifyHome,
  readQuestifyHome,
  sameQuestifyHome,
} from "#src/layout/questify-home";

const slide = (title: string, action: unknown = { type: "none" }) => ({
  title: { ar: "", en: title },
  subtitle: { ar: "", en: "" },
  action,
});
const home = (overrides: Record<string, unknown> = {}) => ({
  order: QUESTIFY_HOME_KEYS,
  hidden: [],
  banner: [],
  ...overrides,
});
const issuesOf = (input: unknown): string[] => {
  const checked = checkQuestifyHome(input);
  return checked.ok ? [] : checked.issues.map((issue) => `${issue.path}: ${issue.message}`);
};

describe("Questify home's blocks (T-713, FR-1838)", () => {
  it("draws the blocks in the order the screen always had, the banner first and empty", () => {
    expect(QUESTIFY_HOME_KEYS.join()).toBe(
      "banner,notices,code,account,operator,invitations,streak,dailyChallenge,dailyWord,events,quests",
    );
    expect(DEFAULT_QUESTIFY_HOME).toEqual({ order: QUESTIFY_HOME_KEYS, hidden: [], banner: [] });
    expect(DEFAULT_COMPOSED_QUESTIFY_HOME).toEqual({ blocks: QUESTIFY_HOME_KEYS, banner: [] });
  });

  it("protects the notices, the code, the account email, operator mode, invitations and My events", () => {
    expect([...QUESTIFY_HOME_PROTECTED].toSorted()).toEqual([
      "account",
      "code",
      "events",
      "invitations",
      "notices",
      "operator",
    ]);
    expect(QUESTIFY_HOME_BLOCKS.map((entry) => entry.title)).toEqual(
      QUESTIFY_HOME_KEYS.map((key) => `questifyHome.block.${key}`),
    );
  });
});

describe("reading a stored layout", () => {
  it("is the default when nothing, or something that is not an object, is stored", () => {
    for (const stored of [undefined, null, "x", 3, [], {}]) {
      expect(readQuestifyHome(stored)).toEqual(DEFAULT_QUESTIFY_HOME);
    }
  });

  it("keeps the stored order and hidden blocks, and lets a missing block join the end", () => {
    const read = readQuestifyHome({
      order: ["dailyWord", "dailyChallenge", "banner"],
      hidden: ["streak"],
    });
    expect(read.order.slice(0, 3)).toEqual(["dailyWord", "dailyChallenge", "banner"]);
    expect(read.order).toHaveLength(QUESTIFY_HOME_KEYS.length);
    expect(read.hidden).toEqual(["streak"]);
  });

  it("drops names it does not know, counts a block listed twice once and never hides a protected block", () => {
    const read = readQuestifyHome({
      order: ["quests", "ghost", "quests", "events"],
      hidden: ["events", "ghost", "quests"],
    });
    expect(read.order.slice(0, 2)).toEqual(["quests", "events"]);
    expect(read.hidden).toEqual(["quests"]);
  });

  it("leaves out a slide that is not valid or that opens an event screen, and keeps the others", () => {
    const read = readQuestifyHome({
      banner: [
        slide("Open"),
        { title: { ar: "", en: "" } },
        slide("Agenda", { type: "agenda" }),
        slide("Quest", { type: "quest", questId: "5b0c1e4e-6a53-4f5c-9d51-3a8f4a2f9a10" }),
        slide("Site", { type: "link", url: "https://questify.example/x" }),
      ],
    });
    expect(read.banner.map((entry) => entry.title.en)).toEqual(["Open", "Site"]);
  });

  it("cuts the banner to five slides", () => {
    const six = Array.from({ length: 6 }, (_unused, index) => slide(`S${index}`));
    expect(readQuestifyHome({ banner: six }).banner).toHaveLength(5);
  });
});

describe("checking a layout an admin saves", () => {
  it("accepts the default and returns it unchanged", () => {
    expect(checkQuestifyHome(home())).toEqual({ ok: true, value: DEFAULT_QUESTIFY_HOME });
  });

  it("accepts a reorder, a hidden block and slides that open nothing or a web link", () => {
    const order = ["dailyWord", ...QUESTIFY_HOME_KEYS.filter((key) => key !== "dailyWord")];
    const checked = checkQuestifyHome(
      home({
        order,
        hidden: ["streak", "quests"],
        banner: [slide("A"), slide("B", { type: "link", url: "https://questify.example/b" })],
      }),
    );
    expect(checked).toMatchObject({ ok: true, value: { order, hidden: ["streak", "quests"] } });
  });

  it("refuses what is not an object, a missing part and a part that is not Questify home's", () => {
    expect(issuesOf("x")).toEqual([": must be an object"]);
    expect(issuesOf({ order: QUESTIFY_HOME_KEYS })).toEqual([
      "hidden: is required",
      "banner: is required",
    ]);
    expect(issuesOf(home({ extra: 1 }))).toEqual(["extra: is not a part of Questify home"]);
  });

  it("refuses an order that leaves a block out, lists one twice or names one that does not exist", () => {
    expect(issuesOf(home({ order: QUESTIFY_HOME_KEYS.slice(1) }))).toEqual([
      "order: must list banner",
    ]);
    expect(issuesOf(home({ order: [...QUESTIFY_HOME_KEYS, "events"] }))).toEqual([
      `order.${QUESTIFY_HOME_KEYS.length}: is listed twice`,
    ]);
    expect(issuesOf(home({ order: [...QUESTIFY_HOME_KEYS.slice(1), "ghost"] }))).toEqual([
      `order.${QUESTIFY_HOME_KEYS.length - 1}: is not a block of Questify home`,
    ]);
    expect(issuesOf(home({ order: "banner" }))).toEqual(["order: must be a list"]);
  });

  it("refuses to hide a protected block, a block twice or a block that does not exist", () => {
    expect(issuesOf(home({ hidden: ["events"] }))).toEqual(["hidden: events cannot be hidden"]);
    expect(issuesOf(home({ hidden: ["streak", "streak"] }))).toEqual(["hidden.1: is listed twice"]);
    expect(issuesOf(home({ hidden: ["ghost"] }))).toEqual([
      "hidden.0: is not a block of Questify home",
    ]);
    expect(issuesOf(home({ hidden: [3] }))).toEqual(["hidden.0: is not a block of Questify home"]);
  });

  it("refuses a sixth slide, a slide with no title and a tap into an event's screens", () => {
    expect(issuesOf(home({ banner: Array.from({ length: 6 }, () => slide("S")) }))).toEqual([
      "banner: has more than 5 items",
    ]);
    expect(issuesOf(home({ banner: [slide("")] }))).toEqual([
      "banner.0.title: needs text in Arabic or English",
    ]);
    expect(issuesOf(home({ banner: [slide("A", { type: "maps" })] }))).toEqual([
      "banner.0.action: must open nothing or a web link",
    ]);
  });

  it("refuses a link that is not https to a named host", () => {
    for (const url of [
      "http://questify.example",
      "javascript:alert(1)",
      "https://127.0.0.1/x",
      "",
    ]) {
      expect(issuesOf(home({ banner: [slide("A", { type: "link", url })] }))).toEqual([
        "banner.0.action.url: must be a full https link",
      ]);
    }
  });

  it("cleans a slide's text: invisible characters go and Arabic-Indic digits become Western", () => {
    const checked = checkQuestifyHome(
      home({ banner: [{ title: { ar: "عرض ٣٠٪​", en: "" }, subtitle: { ar: "", en: "" } }] }),
    );
    expect(checked).toMatchObject({ ok: true, value: { banner: [{ title: { ar: "عرض 30٪" } }] } });
  });

  it("refuses text over its limit and a field a slide does not have", () => {
    expect(issuesOf(home({ banner: [slide("x".repeat(61))] }))).toEqual([
      "banner.0.title.en: is longer than 60 characters",
    ]);
    expect(issuesOf(home({ banner: [{ ...slide("A"), color: "x" }] }))).toEqual([
      "banner.0.color: is not a field of this block",
    ]);
    // An event's slide may carry an image (T-610b); Questify's home has no bucket of its own (ADR-829).
    const image = "0f0e0d0c-0b0a-4908-8706-050403020100";
    expect(issuesOf(home({ banner: [{ ...slide("A"), image }] }))).toEqual([
      "banner.0.image: is not a part of a Questify slide",
    ]);
    expect(readQuestifyHome({ banner: [{ ...slide("A"), image }] }).banner[0]).toEqual(slide("A"));
  });
});

describe("the catalog schema of a save", () => {
  it("returns the checked layout and names each problem by its path", () => {
    expect(homeLayoutDocSchema.safeParse(home()).success).toBe(true);
    const refused = homeLayoutDocSchema.safeParse(
      home({ hidden: ["events"], banner: [slide("")] }),
    );
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "hidden",
      "banner.0.title",
    ]);
    expect(homeLayoutDocSchema.safeParse("x").error?.issues[0]?.path).toEqual([]);
  });
});

describe("what the app receives", () => {
  it("keeps the shown blocks in order and the banner only while its block is shown", () => {
    const layout = readQuestifyHome(home({ hidden: ["streak"], banner: [slide("A")] }));
    const composed = composedQuestifyHomeOf(layout);
    expect(composed.blocks).not.toContain("streak");
    expect(composed.banner).toHaveLength(1);
    const noBanner = composedQuestifyHomeOf(
      readQuestifyHome(home({ hidden: ["banner"], banner: [slide("A")] })),
    );
    expect(noBanner.blocks).not.toContain("banner");
    expect(noBanner.banner).toEqual([]);
  });

  it("reads a received copy tolerantly and falls back to the default order", () => {
    expect(readComposedQuestifyHome(undefined)).toEqual(DEFAULT_COMPOSED_QUESTIFY_HOME);
    expect(readComposedQuestifyHome({ blocks: "x" })).toEqual(DEFAULT_COMPOSED_QUESTIFY_HOME);
    // A copy that leaves out a protected block cannot take the player's events off the screen.
    expect(readComposedQuestifyHome({ blocks: ["quests", "banner"] }).blocks).toEqual(
      QUESTIFY_HOME_KEYS,
    );
    const received = readComposedQuestifyHome({
      blocks: [...QUESTIFY_HOME_KEYS].toReversed().concat("ghost" as never),
      banner: [slide("A"), "junk"],
    });
    expect(received.blocks).toEqual([...QUESTIFY_HOME_KEYS].toReversed());
    expect(received.banner).toHaveLength(1);
  });

  it("compares layouts by order, hidden set and slides", () => {
    const a = readQuestifyHome(home({ hidden: ["streak", "quests"], banner: [slide("A")] }));
    expect(
      sameQuestifyHome(
        a,
        readQuestifyHome(home({ hidden: ["quests", "streak"], banner: [slide("A")] })),
      ),
    ).toBe(true);
    expect(sameQuestifyHome(a, { ...a, hidden: ["streak"] })).toBe(false);
    expect(sameQuestifyHome(a, { ...a, order: [...a.order].toReversed() })).toBe(false);
    expect(sameQuestifyHome(a, { ...a, banner: [] })).toBe(false);
  });
});

describe("in the composed configuration", () => {
  it("is the default order when no layout is stored and the stored one when there is", () => {
    expect(composeConfig(REGISTRIES, {}, undefined).questifyHome).toEqual(
      DEFAULT_COMPOSED_QUESTIFY_HOME,
    );
    const platform = readPlatformSettings({
      questifyHome: home({ order: [...QUESTIFY_HOME_KEYS].toReversed(), banner: [slide("A")] }),
    });
    const body = composeConfig(REGISTRIES, platform, undefined);
    expect(body.questifyHome.blocks[0]).toBe("quests");
    expect(body.questifyHome.banner).toHaveLength(1);
  });

  it("survives the app's own parse, and a copy from before the layout existed reads as the default", () => {
    const body = composeConfig(
      REGISTRIES,
      readPlatformSettings({ questifyHome: home() }),
      undefined,
    );
    const withLegal = { ...body, legal: { documents: [] } };
    const parsed = parseComposedConfig(withLegal);
    expect(parsed.ok && parsed.config.questifyHome).toEqual(DEFAULT_COMPOSED_QUESTIFY_HOME);
    const { questifyHome: _unused, ...older } = withLegal;
    const parsedOlder = parseComposedConfig(older);
    expect(parsedOlder.ok && parsedOlder.config.questifyHome).toEqual(
      DEFAULT_COMPOSED_QUESTIFY_HOME,
    );
  });
});
