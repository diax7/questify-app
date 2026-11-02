import type { AchievementAdmin, GemShopItemAdmin, TemplateAdmin } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  achievementDraftOf,
  byLevel,
  checkAchievement,
  checkLevelTitles,
  checkShop,
  checkTemplate,
  isAchievementDirty,
  isLevelTitlesDirty,
  isShopDirty,
  isTemplateDirty,
  isTemplateKey,
  levelTitlesDraftOf,
  newTemplateDraft,
  parseBody,
  readAchievements,
  readGemShop,
  readLevelTitles,
  readTemplates,
  revertPath,
  rowPath,
  shopDraftOf,
  storedBodyIssues,
  templateCounts,
  templateDraftOf,
} from "#src/lib/console-catalog.ts";

const quest = {
  type: "scan_qr",
  titleAr: "عنوان",
  titleEn: "Title",
  descriptionAr: "وصف",
  descriptionEn: "Text",
  points: 10,
  repeatCap: 1,
  typeConfig: {},
};
const body = {
  config: { features: {}, accent: "honey", layoutPreset: "classic" },
  categories: [
    { nameAr: "فئة", nameEn: "Group", orderMode: "any", completionBonus: 0, quests: [quest] },
  ],
  rewards: [],
};
const template: TemplateAdmin = {
  key: "conference",
  position: 1,
  name: { ar: "مؤتمر", en: "Conference" },
  description: { ar: "وصف", en: "Description" },
  body,
  enabled: true,
  updatedAt: "2026-11-02T10:00:00+00:00",
  revertible: false,
};
const achievement: AchievementAdmin = {
  id: "quests-done",
  metric: "quests",
  bronze: 10,
  silver: 50,
  gold: 200,
  name: { ar: "صائد المهام", en: "Quest Hunter" },
  visualKey: "ach-collector",
  position: 2,
  revertible: false,
};
const item: GemShopItemAdmin = {
  itemId: "shop-map-reader",
  kind: "title",
  name: { ar: "قارئ الخرائط", en: "Map reader" },
  visualKey: null,
  price: 40,
  status: "active",
  position: 1,
  revertible: true,
};

describe("the readers", () => {
  it("answer the rows of a well-formed list and undefined for any other shape", () => {
    expect(readTemplates({ templates: [template] })).toEqual([template]);
    expect(readAchievements({ achievements: [achievement] })).toEqual([achievement]);
    expect(readGemShop({ items: [item] })).toEqual([item]);
    expect(
      readLevelTitles({
        titles: [{ levelFrom: 1, name: { ar: "ا", en: "A" } }],
        revertible: false,
      }),
    ).toEqual({ titles: [{ levelFrom: 1, name: { ar: "ا", en: "A" } }], revertible: false });
    for (const read of [readTemplates, readAchievements, readGemShop, readLevelTitles]) {
      expect(read({}), read.name).toBeUndefined();
      expect(read(null), read.name).toBeUndefined();
      expect(read({ extra: true }), read.name).toBeUndefined();
    }
  });

  it("builds the API path of a row and of its revert", () => {
    expect(rowPath("/v1/admin/catalog/templates", "conference")).toBe(
      "/v1/admin/catalog/templates/conference",
    );
    expect(revertPath("/v1/admin/catalog/level-titles")).toBe(
      "/v1/admin/catalog/level-titles/revert",
    );
  });
});

describe("a template draft", () => {
  it("round-trips a stored template into a valid edit document and is not dirty until changed", () => {
    const draft = templateDraftOf(template);
    const checked = checkTemplate(draft);
    expect(checked.ok && checked.doc.name).toEqual(template.name);
    expect(isTemplateDirty(template, draft)).toBe(false);
    expect(isTemplateDirty(template, { ...draft, enabled: false })).toBe(true);
    expect(isTemplateDirty(template, { ...draft, name: { ...draft.name, en: "Other" } })).toBe(
      true,
    );
    expect(isTemplateDirty(template, { ...draft, body: `${draft.body}\n` })).toBe(false);
  });

  it("refuses text that is not JSON, a swapped language, control and direction characters and a bad setup", () => {
    const draft = templateDraftOf(template);
    const notJson = checkTemplate({ ...draft, body: "{ not json" });
    expect(!notJson.ok && notJson.fields.has("body")).toBe(true);
    const swapped = checkTemplate({ ...draft, name: { ar: "Conference", en: "Conference" } });
    expect(!swapped.ok && swapped.fields.has("name.ar")).toBe(true);
    const bidi = checkTemplate({ ...draft, name: { ar: "مؤتمر", en: "Con‮ference" } });
    expect(!bidi.ok && bidi.fields.has("name.en")).toBe(true);
    const blank = checkTemplate({ ...draft, description: { ar: "  ", en: "Text" } });
    expect(!blank.ok && blank.fields.has("description.ar")).toBe(true);
    const empty = checkTemplate({ ...draft, body: "{}" });
    expect(!empty.ok && [...empty.fields].some((field) => field.startsWith("body"))).toBe(true);
    const arabicDigit = checkTemplate({ ...draft, name: { ar: "مؤتمر ٢٠٢٦", en: "Conference" } });
    expect(arabicDigit.ok).toBe(false);
  });

  it("starts a new template switched off, from the setup of another, and checks its key", () => {
    const fresh = newTemplateDraft(template);
    expect(fresh).toMatchObject({ key: "", enabled: false });
    expect(parseBody(fresh.body)).toEqual(body);
    expect(newTemplateDraft(undefined).body).toBe("{}");
    expect(isTemplateKey("summit_2")).toBe(true);
    for (const key of ["", "a", "Summit", "2summit", "sum-mit", "a".repeat(31)]) {
      expect(isTemplateKey(key), key).toBe(false);
    }
  });

  it("counts a stored setup and says why a broken one cannot be used", () => {
    expect(templateCounts(template)).toEqual({ categories: 1, quests: 1, rewards: 0 });
    const broken = { ...template, body: { categories: "no" } };
    expect(templateCounts(broken)).toBeUndefined();
    expect(storedBodyIssues(template)).toEqual([]);
    expect(storedBodyIssues(broken).length).toBeGreaterThan(0);
    expect(parseBody("nope")).toBeUndefined();
  });
});

describe("an achievement draft", () => {
  it("holds the name only, so a save can never carry a threshold", () => {
    const draft = achievementDraftOf(achievement);
    expect(Object.keys(draft)).toEqual(["name"]);
    expect(isAchievementDirty(achievement, draft)).toBe(false);
    expect(checkAchievement(draft)).toEqual({ ok: true, doc: { name: achievement.name } });
    expect(isAchievementDirty(achievement, { name: { ar: "صائد", en: "Quest Hunter" } })).toBe(
      true,
    );
    expect(
      isAchievementDirty(achievement, { name: { ar: "صائد المهام ", en: " Quest Hunter" } }),
    ).toBe(false);
  });

  it("refuses a blank, unsafe or swapped-language name", () => {
    const draft = achievementDraftOf(achievement);
    for (const [name, field] of [
      [{ ar: "ا\u0007", en: "A" }, "name.ar"],
      [{ ar: "ا", en: "A\u202e" }, "name.en"],
      [{ ar: "   ", en: "A" }, "name.ar"],
      [{ ar: "Name", en: "Name" }, "name.ar"],
      [{ ar: "ا", en: "اسم" }, "name.en"],
      [{ ar: "ا٣", en: "A" }, "name.ar"],
    ] as const) {
      const checked = checkAchievement({ ...draft, name });
      expect(!checked.ok && checked.fields.has(field), JSON.stringify(name)).toBe(true);
    }
  });
});

describe("a level-titles draft", () => {
  const set = {
    titles: [
      { levelFrom: 6, name: { ar: "ب", en: "B" } },
      { levelFrom: 1, name: { ar: "ا", en: "A" } },
    ],
    revertible: false,
  };

  it("lists the ranges in level order and checks the whole set", () => {
    const drafts = levelTitlesDraftOf(set);
    expect(byLevel(drafts).map((title) => title.levelFrom)).toEqual(["1", "6"]);
    expect(checkLevelTitles(drafts).ok).toBe(true);
    expect(isLevelTitlesDirty(set, drafts)).toBe(false);
    expect(isLevelTitlesDirty(set, drafts.slice(1))).toBe(true);
  });

  it("refuses a set with no level 1, a level twice, an empty set or a blank range", () => {
    const drafts = levelTitlesDraftOf(set);
    const noFirst = checkLevelTitles([{ ...drafts[0]! }]);
    expect(!noFirst.ok && noFirst.fields.has("titles")).toBe(true);
    const twice = checkLevelTitles([drafts[1]!, drafts[1]!]);
    expect(!twice.ok && twice.fields.has("titles")).toBe(true);
    expect(checkLevelTitles([]).ok).toBe(false);
    const blank = checkLevelTitles([...drafts, { levelFrom: "", name: { ar: "", en: "" } }]);
    expect(!blank.ok && blank.fields.has("titles.2.levelFrom")).toBe(true);
    const long = checkLevelTitles([{ levelFrom: "1", name: { ar: "ا".repeat(41), en: "A" } }]);
    expect(!long.ok && long.fields.has("titles.0.name.ar")).toBe(true);
  });
});

describe("a gem shop draft", () => {
  it("accepts a whole price and place and a known status", () => {
    const draft = shopDraftOf(item);
    expect(isShopDirty(item, draft)).toBe(false);
    expect(checkShop(draft)).toMatchObject({ ok: true, doc: { price: 40, status: "active" } });
    expect(isShopDirty(item, { ...draft, status: "retired" })).toBe(true);
    expect(isShopDirty(item, { ...draft, price: "41" })).toBe(true);
  });

  it("refuses a price or place that is zero, too big or not a whole number", () => {
    const draft = shopDraftOf(item);
    for (const [change, field] of [
      [{ price: "0" }, "price"],
      [{ price: "100001" }, "price"],
      [{ price: "4.5" }, "price"],
      [{ price: "" }, "price"],
      [{ position: "0" }, "position"],
      [{ position: "1001" }, "position"],
    ] as const) {
      const checked = checkShop({ ...draft, ...change });
      expect(!checked.ok && checked.fields.has(field), JSON.stringify(change)).toBe(true);
    }
  });
});
