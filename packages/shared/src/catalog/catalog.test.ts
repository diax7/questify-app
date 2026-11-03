import { describe, expect, it } from "vitest";
import {
  ACHIEVEMENT_ID,
  AMOUNT_RANGES,
  GEM_AMOUNTS,
  ITEM_ID,
  TEMPLATE_BODY_MAX_BYTES,
  XP_AMOUNTS,
  achievementAdminAnswerSchema,
  achievementAdminSchema,
  achievementBeforeSchema,
  achievementDocSchema,
  achievementsAdminListSchema,
  amountsAdminSchema,
  amountsDocSchema,
  gemShopAdminListSchema,
  gemShopDocSchema,
  gemShopItemAdminAnswerSchema,
  gemShopItemAdminSchema,
  homeLayoutAdminSchema,
  homeLayoutDocSchema,
  levelTitlesAdminSchema,
  levelTitlesDocSchema,
  loweredGemsSchema,
  templateAdminAnswerSchema,
  templateAdminSchema,
  templateBodyIssues,
  templateDocSchema,
  templatesAdminListSchema,
} from "#src/catalog/catalog";
import { templateBodySchema } from "#src/templates/template";
import { arabicText, englishText } from "#src/text/bilingual";

const quest = {
  type: "scan_qr",
  titleAr: "سجّل حضورك",
  titleEn: "Check in",
  descriptionAr: "امسح الرمز.",
  descriptionEn: "Scan the code.",
  points: 50,
  repeatCap: 1,
  typeConfig: {},
};
const reward = (descriptionAr: string, descriptionEn: string) => ({
  kind: "experience",
  nameAr: "جولة",
  nameEn: "Tour",
  descriptionAr,
  descriptionEn,
  price: 300,
  perPlayerLimit: null,
  section: null,
  tagNew: false,
  tagLimited: false,
});
const doc = (rewards: unknown[]) => ({
  name: { ar: "مؤتمر", en: "Conference" },
  description: { ar: "يوم طويل.", en: "A long day." },
  body: {
    config: { features: {}, accent: "sky", layoutPreset: "classic" },
    categories: [
      { nameAr: "البداية", nameEn: "Start", orderMode: "any", completionBonus: 0, quests: [quest] },
    ],
    rewards,
  },
  enabled: true,
});

const messagesOf = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((issue) => issue.message) ?? [];

describe("template body size", () => {
  it("accepts a setup under the limit", () => {
    expect(
      templateDocSchema.safeParse(doc([reward("ا".repeat(200), "a".repeat(200))])).success,
    ).toBe(true);
  });

  it("refuses a setup over the limit and says its size, the limit and why", () => {
    const rewards = Array.from({ length: 6 }, () => reward("ا".repeat(2000), "a".repeat(2000)));
    const result = templateDocSchema.safeParse(doc(rewards));
    expect(result.success).toBe(false);
    const [message] = messagesOf(result);
    expect(message).toContain(String(TEMPLATE_BODY_MAX_BYTES));
    expect(message).toMatch(/\d+ bytes/);
    expect(message).toContain("audit log");
  });

  it("counts bytes, not characters: Arabic letters take two", () => {
    const rewards = Array.from({ length: 8 }, () => reward("ا".repeat(2000), "a"));
    const text = JSON.stringify(doc(rewards).body);
    expect(text.length).toBeLessThan(TEMPLATE_BODY_MAX_BYTES);
    expect(templateDocSchema.safeParse(doc(rewards)).success).toBe(false);
  });
});

describe("achievement edit document", () => {
  const name = { ar: "صائد المهام", en: "Quest Hunter" };

  it("holds the name and three whole thresholds 1 to 100,000, strictly rising", () => {
    expect(
      achievementDocSchema.safeParse({ name, bronze: 1, silver: 2, gold: 100_000 }).success,
    ).toBe(true);
    for (const tiers of [
      { bronze: 5, silver: 5, gold: 10 },
      { bronze: 6, silver: 5, gold: 10 },
      { bronze: 1, silver: 10, gold: 10 },
      { bronze: 0, silver: 5, gold: 10 },
      { bronze: 1, silver: 5, gold: 100_001 },
      { bronze: 1.5, silver: 5, gold: 10 },
      { bronze: 1, silver: 5 },
    ]) {
      expect(
        achievementDocSchema.safeParse({ name, ...tiers }).success,
        JSON.stringify(tiers),
      ).toBe(false);
    }
  });

  it("refuses anything else, the confirmation included (the route takes it apart)", () => {
    for (const extra of [{ threshold: 1 }, { confirmed: true }]) {
      expect(
        achievementDocSchema.safeParse({ name, bronze: 1, silver: 2, gold: 3, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it("reverts an entry with the name alone (T-709b's entries)", () => {
    expect(achievementBeforeSchema.safeParse({ name }).success).toBe(true);
    expect(achievementBeforeSchema.safeParse({ name, bronze: 1, silver: 2, gold: 3 }).success).toBe(
      true,
    );
  });

  it("reads the gems a lowering pays, per lowered tier", () => {
    expect(loweredGemsSchema.safeParse({ bronze: 10, gold: 50 }).success).toBe(true);
    expect(loweredGemsSchema.safeParse({ platinum: 1 }).success).toBe(false);
  });
});

describe("amounts document", () => {
  const amounts = {
    xp: { questXp: 100, dailyFinishXp: 20, dailyRightXp: 10, dailyWordXp: 50 },
    gems: { levelUp: 20, bronze: 10, silver: 25, gold: 50 },
  };

  it("takes every range's ends and refuses one past them", () => {
    for (const group of ["xp", "gems"] as const) {
      for (const [field, [low, high]] of Object.entries(AMOUNT_RANGES[group])) {
        const at = (value: number) => ({
          ...amounts,
          [group]: { ...amounts[group], [field]: value },
        });
        expect(amountsDocSchema.safeParse(at(low)).success, `${field} ${low}`).toBe(true);
        expect(amountsDocSchema.safeParse(at(high)).success, `${field} ${high}`).toBe(true);
        expect(amountsDocSchema.safeParse(at(low - 1)).success, `${field} ${low - 1}`).toBe(false);
        expect(amountsDocSchema.safeParse(at(high + 1)).success, `${field} ${high + 1}`).toBe(
          false,
        );
      }
    }
  });

  it("names every amount once and refuses a missing or extra one", () => {
    expect(Object.keys(AMOUNT_RANGES.xp)).toEqual([...XP_AMOUNTS]);
    expect(Object.keys(AMOUNT_RANGES.gems)).toEqual([...GEM_AMOUNTS]);
    const { gold: _gold, ...three } = amounts.gems;
    expect(amountsDocSchema.safeParse({ ...amounts, gems: three }).success).toBe(false);
    expect(
      amountsDocSchema.safeParse({ ...amounts, gems: { ...amounts.gems, ruby: 1 } }).success,
    ).toBe(false);
    expect(amountsDocSchema.safeParse({ ...amounts, moderation: {} }).success).toBe(false);
  });
});

describe("a name an admin types", () => {
  it("says Western digits when another script's digits are the problem", () => {
    const result = arabicText(20).safeParse("اسم ٣");
    expect(messagesOf(result)).toEqual(["Western digits only"]);
  });

  it("says control or direction characters when one is the problem, and not digits", () => {
    expect(messagesOf(arabicText(20).safeParse("اسم\u0007"))).toEqual([
      "no control or direction characters",
    ]);
    expect(messagesOf(englishText(20).safeParse("Na‮me"))).toEqual([
      "no control or direction characters",
    ]);
  });

  it("reports both when a name has both problems", () => {
    expect(messagesOf(arabicText(20).safeParse("اسم ٣\u0007"))).toEqual([
      "Western digits only",
      "no control or direction characters",
    ]);
  });
});

type Issues = Readonly<{
  error?: { issues: readonly { code: string; path: PropertyKey[]; message: string }[] };
}>;
const issuesOf = (result: Issues) =>
  (result.error?.issues ?? []).map(({ code, path, message }) => ({ code, path, message }));

/** The bytes of a setup's body as the schema reads it. */
const sizeOf = (setup: ReturnType<typeof doc>) =>
  new TextEncoder().encode(JSON.stringify(templateBodySchema.parse(setup.body))).length;

describe("template body size at the limit", () => {
  const full = reward("ا".repeat(2000), "a".repeat(1500));
  /** A reward `padding` bytes longer than the shortest: two bytes an Arabic letter, one an English one. */
  const padded = (padding: number) => {
    const arabic = Math.min(Math.floor(padding / 2), 1999);
    return reward("ا".repeat(1 + arabic), "a".repeat(1 + padding - 2 * arabic));
  };

  const at = (fulls: number, padding: number) =>
    doc([...Array.from({ length: fulls }, () => full), padded(padding)]);

  /** A setup whose body, as the schema reads it, is exactly `bytes` long: full rewards, then one padded to fit. */
  const sizedDoc = (bytes: number) => {
    let fulls = 0;
    while (sizeOf(at(fulls + 1, 0)) <= bytes) {
      fulls += 1;
    }
    const sized = at(fulls, bytes - sizeOf(at(fulls, 0)));
    expect(sizeOf(sized)).toBe(bytes);
    return sized;
  };

  it("takes a body of exactly the limit and refuses one byte more, as a custom issue on the body", () => {
    expect(templateDocSchema.safeParse(sizedDoc(TEMPLATE_BODY_MAX_BYTES)).success).toBe(true);
    const over = issuesOf(templateDocSchema.safeParse(sizedDoc(TEMPLATE_BODY_MAX_BYTES + 1)));
    expect(over).toEqual([
      {
        code: "custom",
        path: ["body"],
        message: `the setup is ${TEMPLATE_BODY_MAX_BYTES + 1} bytes and at most ${TEMPLATE_BODY_MAX_BYTES} can be saved (every change is kept twice in the audit log)`,
      },
    ]);
  });
});

describe("achievement thresholds out of order", () => {
  it("says they must rise, as a custom issue on the thresholds", () => {
    const name = { ar: "صائد المهام", en: "Quest Hunter" };
    expect(
      issuesOf(achievementDocSchema.safeParse({ name, bronze: 5, silver: 5, gold: 10 })),
    ).toEqual([
      {
        code: "custom",
        path: ["thresholds"],
        message: "the thresholds must rise from bronze to gold",
      },
    ]);
  });

  it("reads a lowering's gems for any tier, each 1 or more", () => {
    expect(loweredGemsSchema.parse({ silver: 25 })).toEqual({ silver: 25 });
    expect(loweredGemsSchema.safeParse({ silver: 0 }).success).toBe(false);
  });
});

describe("catalog ids", () => {
  it("takes a lower-case letter then up to 63 letters, digits or dashes, and nothing around it", () => {
    for (const pattern of [ACHIEVEMENT_ID, ITEM_ID]) {
      for (const id of ["a", "gold-frame", "q9", `a${"b".repeat(63)}`]) {
        expect(pattern.test(id), id).toBe(true);
      }
      for (const id of ["Gold", "9gold", "-gold", "gold!", "gold frame", `a${"b".repeat(64)}`]) {
        expect(pattern.test(id), id).toBe(false);
      }
    }
  });
});

const title = (levelFrom: number) => ({ levelFrom, name: { ar: "مستكشف", en: "Explorer" } });

describe("level titles document", () => {
  it("takes 1 to 100 titles, one from level 1, each from level 1 to 100", () => {
    const one = { titles: [title(1)] };
    expect(levelTitlesDocSchema.parse(one)).toEqual(one);
    expect(levelTitlesDocSchema.safeParse({ titles: [title(1), title(100)] }).success).toBe(true);
    const hundred = { titles: Array.from({ length: 100 }, (_, index) => title(index + 1)) };
    expect(levelTitlesDocSchema.safeParse(hundred).success).toBe(true);
    for (const titles of [
      [],
      [title(1), title(101)],
      [title(1), title(0)],
      [title(1), title(2.5)],
    ]) {
      expect(levelTitlesDocSchema.safeParse({ titles }).success, JSON.stringify(titles)).toBe(
        false,
      );
    }
    const tooMany = [...hundred.titles, title(1)];
    expect(levelTitlesDocSchema.safeParse({ titles: tooMany }).success).toBe(false);
    expect(levelTitlesDocSchema.safeParse({ titles: [{ levelFrom: 1 }] }).success).toBe(false);
  });

  it("says level 1 needs a title, and that a level has two, on the titles", () => {
    expect(issuesOf(levelTitlesDocSchema.safeParse({ titles: [title(2)] }))).toEqual([
      { code: "custom", path: ["titles"], message: "level 1 needs a title" },
    ]);
    expect(issuesOf(levelTitlesDocSchema.safeParse({ titles: [title(1), title(1)] }))).toEqual([
      { code: "custom", path: ["titles"], message: "a level has two titles" },
    ]);
    expect(issuesOf(levelTitlesDocSchema.safeParse({ titles: [title(2), title(2)] }))).toEqual([
      { code: "custom", path: ["titles"], message: "level 1 needs a title" },
      { code: "custom", path: ["titles"], message: "a level has two titles" },
    ]);
  });
});

describe("gem shop document", () => {
  it("takes a price of 1 to 100,000 and a place of 1 to 1,000, and refuses past them", () => {
    const item = { price: 1, status: "active", position: 1 };
    expect(gemShopDocSchema.parse(item)).toEqual(item);
    expect(
      gemShopDocSchema.safeParse({ price: 100_000, status: "retired", position: 1000 }).success,
    ).toBe(true);
    for (const change of [{ price: 0 }, { price: 100_001 }, { position: 0 }, { position: 1001 }]) {
      expect(
        gemShopDocSchema.safeParse({ ...item, ...change }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
    expect(gemShopDocSchema.safeParse({ price: 1, status: "active" }).success).toBe(false);
  });
});

describe("the console's catalog rows", () => {
  const name = { ar: "اسم", en: "Name" };
  const template = {
    key: "conference",
    position: 3,
    name,
    description: name,
    body: {},
    enabled: true,
    updatedAt: "2030-01-01T00:00:00Z",
    revertible: false,
  };
  const achievement = {
    id: "quests-done",
    metric: "quests",
    bronze: 1,
    silver: 2,
    gold: 3,
    name,
    visualKey: "trophy",
    position: 2,
    revertible: true,
  };
  const shopItem = {
    itemId: "gold-frame",
    kind: "frame",
    name,
    visualKey: null,
    price: 5,
    status: "active",
    position: 4,
    revertible: false,
  };

  it("reads a template, a list of them and one, and refuses a malformed one", () => {
    expect(templateAdminSchema.parse(template)).toEqual(template);
    expect(templatesAdminListSchema.parse({ templates: [template] })).toEqual({
      templates: [template],
    });
    expect(templateAdminAnswerSchema.parse({ template })).toEqual({ template });
    for (const change of [{ position: 0 }, { name: {} }, { description: { ar: "و" } }]) {
      expect(templateAdminSchema.safeParse({ ...template, ...change }).success).toBe(false);
    }
    expect(templatesAdminListSchema.safeParse({}).success).toBe(false);
    expect(templateAdminAnswerSchema.safeParse({}).success).toBe(false);
  });

  it("reads an achievement of each metric, a list of them and one", () => {
    for (const metric of ["events", "quests", "cities", "top10", "goals"]) {
      expect(achievementAdminSchema.parse({ ...achievement, metric }).metric).toBe(metric);
    }
    expect(achievementsAdminListSchema.parse({ achievements: [achievement] })).toEqual({
      achievements: [achievement],
    });
    expect(achievementAdminAnswerSchema.parse({ achievement })).toEqual({ achievement });
    for (const change of [{ metric: "streak" }, { position: 0 }, { name: {} }]) {
      expect(achievementAdminSchema.safeParse({ ...achievement, ...change }).success).toBe(false);
    }
    expect(achievementsAdminListSchema.safeParse({}).success).toBe(false);
    expect(achievementAdminAnswerSchema.safeParse({}).success).toBe(false);
  });

  it("reads a gem shop item of each kind, a list of them and one", () => {
    for (const kind of ["character", "frame", "title"]) {
      expect(gemShopItemAdminSchema.parse({ ...shopItem, kind }).kind).toBe(kind);
    }
    expect(gemShopAdminListSchema.parse({ items: [shopItem] })).toEqual({ items: [shopItem] });
    expect(gemShopItemAdminAnswerSchema.parse({ item: shopItem })).toEqual({ item: shopItem });
    for (const change of [{ kind: "badge" }, { price: 0 }, { position: 0 }, { name: {} }]) {
      expect(gemShopItemAdminSchema.safeParse({ ...shopItem, ...change }).success).toBe(false);
    }
    expect(gemShopAdminListSchema.safeParse({}).success).toBe(false);
    expect(gemShopItemAdminAnswerSchema.safeParse({}).success).toBe(false);
  });

  it("reads the amounts with what is stored, and the level titles from level 1", () => {
    const amounts = {
      xp: { questXp: 100, dailyFinishXp: 20, dailyRightXp: 10, dailyWordXp: 50 },
      gems: { levelUp: 20, bronze: 10, silver: 25, gold: 50 },
      stored: { xp: true, gems: false },
      revertible: false,
    };
    expect(amountsAdminSchema.parse(amounts)).toEqual(amounts);
    expect(amountsAdminSchema.safeParse({ ...amounts, stored: {} }).success).toBe(false);
    expect(amountsAdminSchema.safeParse({ ...amounts, xp: {} }).success).toBe(false);
    const titles = {
      titles: [
        { levelFrom: 1, name },
        { levelFrom: 5, name },
      ],
      revertible: true,
    };
    expect(levelTitlesAdminSchema.parse(titles)).toEqual(titles);
    for (const listed of [{ levelFrom: 1 }, { levelFrom: 1, name: {} }, { levelFrom: 0, name }]) {
      expect(levelTitlesAdminSchema.safeParse({ ...titles, titles: [listed] }).success).toBe(false);
    }
    expect(levelTitlesAdminSchema.safeParse({ titles: [] }).success).toBe(false);
  });

  it("reads Questify home's layout, and refuses one with a part missing", () => {
    const home = { order: ["banner"], hidden: [], banner: [], revertible: false };
    expect(homeLayoutAdminSchema.parse(home)).toEqual(home);
    expect(homeLayoutAdminSchema.safeParse({ order: [], hidden: [], banner: [] }).success).toBe(
      false,
    );
    const refused = issuesOf(homeLayoutDocSchema.safeParse({ order: [], hidden: [] }));
    expect(refused).toEqual([{ code: "custom", path: ["banner"], message: "is required" }]);
  });
});

describe("a template body's issues for the editor", () => {
  it("names nothing for a good body", () => {
    expect(templateBodyIssues(doc([reward("جولة", "Tour")]).body)).toEqual([]);
  });

  it("names each issue by its dotted path, or the body itself", () => {
    const body = doc([reward("جولة", "Tour")]).body;
    const broken = {
      ...body,
      categories: [{ ...body.categories[0], quests: [{ ...quest, points: -1 }] }],
    };
    const [issue] = templateBodyIssues(broken);
    expect(issue).toMatch(/^categories\.0\.quests\.0\.points: \S/);
    expect(templateBodyIssues("x")).toEqual([
      `body: ${templateBodySchema.safeParse("x").error?.issues[0]?.message}`,
    ]);
  });
});
