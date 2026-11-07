import {
  MESSAGES,
  XP_AMOUNTS,
  type AchievementAdmin,
  type AmountsAdmin,
  type ItemAdmin,
  type TemplateAdmin,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  achievementDraftOf,
  amountChanges,
  revertChanges,
  amountLabel,
  amountsDraftOf,
  checkAmounts,
  loweredTiersOf,
  readAmounts,
  byLevel,
  checkAchievement,
  checkLevelTitles,
  checkTemplate,
  isAchievementDirty,
  isLevelTitlesDirty,
  isTemplateDirty,
  isTemplateKey,
  levelTitlesDraftOf,
  newTemplateDraft,
  parseBody,
  readAchievements,
  readLevelTitles,
  readTemplates,
  revertPath,
  rowPath,
  storedBodyIssues,
  templateCounts,
  templateDraftOf,
  unlockChoices,
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
  item: null,
  revertible: false,
};
describe("the readers", () => {
  it("answer the rows of a well-formed list and undefined for any other shape", () => {
    expect(readTemplates({ templates: [template] })).toEqual([template]);
    expect(readAchievements({ achievements: [achievement] })).toEqual([achievement]);
    expect(
      readLevelTitles({
        titles: [{ levelFrom: 1, name: { ar: "ا", en: "A" } }],
        revertible: false,
      }),
    ).toEqual({ titles: [{ levelFrom: 1, name: { ar: "ا", en: "A" } }], revertible: false });
    for (const read of [readTemplates, readAchievements, readLevelTitles]) {
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
  it("holds the name and the three thresholds, and is dirty when either changes", () => {
    const draft = achievementDraftOf(achievement);
    expect(draft).toEqual({
      name: achievement.name,
      bronze: "10",
      silver: "50",
      gold: "200",
      itemId: "",
      itemTier: "gold",
    });
    expect(isAchievementDirty(achievement, draft)).toBe(false);
    expect(checkAchievement(achievement, draft)).toEqual({
      ok: true,
      doc: { name: achievement.name, bronze: 10, silver: 50, gold: 200 },
    });
    expect(
      isAchievementDirty(achievement, { ...draft, name: { ar: "صائد", en: "Quest Hunter" } }),
    ).toBe(true);
    expect(
      isAchievementDirty(achievement, {
        ...draft,
        name: { ar: "صائد المهام ", en: " Quest Hunter" },
      }),
    ).toBe(false);
    expect(isAchievementDirty(achievement, { ...draft, silver: "40" })).toBe(true);
    expect(isAchievementDirty(achievement, { ...draft, gold: " 200 " })).toBe(false);
  });

  it("refuses thresholds that are not whole, in range and rising", () => {
    const draft = achievementDraftOf(achievement);
    for (const tiers of [
      { bronze: "50" },
      { silver: "300" },
      { bronze: "0" },
      { gold: "100001" },
      { bronze: "1.5" },
      { bronze: "" },
      { gold: "1e3" },
    ]) {
      expect(checkAchievement(achievement, { ...draft, ...tiers }).ok, JSON.stringify(tiers)).toBe(
        false,
      );
    }
    const falling = checkAchievement(achievement, { ...draft, bronze: "60" });
    expect(!falling.ok && falling.fields.has("thresholds")).toBe(true);
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
      const checked = checkAchievement(achievement, { ...draft, name });
      expect(!checked.ok && checked.fields.has(field), JSON.stringify(name)).toBe(true);
    }
  });

  it("sends the item only when the draft changes it: left out, the API keeps it (T-404d)", () => {
    const holding: AchievementAdmin = {
      ...achievement,
      item: { tier: "silver", itemId: "ring-a" },
    };
    const draft = achievementDraftOf(holding);
    expect(draft).toMatchObject({ itemId: "ring-a", itemTier: "silver" });
    const same = checkAchievement(holding, draft);
    expect(same.ok && "item" in same.doc).toBe(false);
    expect(isAchievementDirty(holding, draft)).toBe(false);
  });

  it("sets, moves and removes the item, and is dirty for each", () => {
    const none = achievementDraftOf(achievement);
    const set = { ...none, itemId: "ring-a", itemTier: "bronze" as const };
    const setDoc = checkAchievement(achievement, set);
    expect(setDoc.ok && setDoc.doc.item).toEqual({ tier: "bronze", itemId: "ring-a" });
    expect(isAchievementDirty(achievement, set)).toBe(true);

    const holding: AchievementAdmin = { ...achievement, item: { tier: "gold", itemId: "ring-a" } };
    const held = achievementDraftOf(holding);
    const moved = checkAchievement(holding, { ...held, itemId: "ring-b" });
    expect(moved.ok && moved.doc.item).toEqual({ tier: "gold", itemId: "ring-b" });
    const retiered = checkAchievement(holding, { ...held, itemTier: "silver" });
    expect(retiered.ok && retiered.doc.item).toEqual({ tier: "silver", itemId: "ring-a" });
    const removed = checkAchievement(holding, { ...held, itemId: "" });
    expect(removed.ok && removed.doc.item).toBeNull();
    expect(isAchievementDirty(holding, { ...held, itemId: "" })).toBe(true);
    expect(isAchievementDirty(holding, { ...held, itemTier: "bronze" })).toBe(true);
  });

  it("changes nothing when an achievement with no item is left with none, whatever tier the box holds", () => {
    const draft = { ...achievementDraftOf(achievement), itemTier: "bronze" as const };
    const checked = checkAchievement(achievement, draft);
    expect(checked.ok && "item" in checked.doc).toBe(false);
    expect(isAchievementDirty(achievement, draft)).toBe(false);
  });

  it("refuses an item id the API would not take", () => {
    const draft = { ...achievementDraftOf(achievement), itemId: "Not An Id" };
    const checked = checkAchievement(achievement, draft);
    expect(!checked.ok && checked.fields.has("item.itemId")).toBe(true);
  });

  it("offers the items nothing else uses, and the one this achievement holds", () => {
    const base = {
      name: { ar: "ا", en: "A" },
      visualKey: null,
      locked: { art: null },
      revertible: false,
    };
    const items: ItemAdmin[] = [
      { ...base, id: "free", kind: "frame", source: null },
      {
        ...base,
        id: "mine",
        kind: "title",
        source: { achievement: { id: "quests-done", tier: "gold" } },
      },
      {
        ...base,
        id: "other",
        kind: "frame",
        source: { achievement: { id: "top-ten", tier: "gold" } },
      },
      { ...base, id: "level-5", kind: "frame", source: { level: 5 } },
    ];
    expect(unlockChoices(items, "quests-done").map((item) => item.id)).toEqual(["free", "mine"]);
    expect(unlockChoices([], "quests-done")).toEqual([]);
  });

  it("reads what a lowering pays only from a confirmation_required answer", () => {
    const tiers = { bronze: { xp: 50, itemId: null } };
    expect(loweredTiersOf({ code: "confirmation_required", details: { tiers } })).toEqual(tiers);
    expect(loweredTiersOf({ code: "stale", details: { tiers } })).toBeUndefined();
    expect(loweredTiersOf({ code: "confirmation_required", details: {} })).toBeUndefined();
    expect(loweredTiersOf(undefined)).toBeUndefined();
  });
});

describe("an amounts draft", () => {
  const row: AmountsAdmin = {
    xp: {
      questXp: 100,
      dailyFinishXp: 20,
      dailyRightXp: 10,
      dailyWordXp: 50,
      bronzeXp: 50,
      silverXp: 150,
      goldXp: 300,
    },
    stored: { xp: true },
    revertible: false,
  };

  it("checks every amount in its range and lists what a save changes, XP first", () => {
    const draft = amountsDraftOf(row);
    const same = checkAmounts(draft);
    expect(same).toEqual({ ok: true, doc: { xp: row.xp } });
    expect(same.ok && amountChanges(row, same.doc)).toEqual([]);
    const edited = checkAmounts({
      xp: { ...draft.xp, dailyWordXp: "0", goldXp: "400" },
    });
    expect(edited.ok && amountChanges(row, edited.doc)).toEqual([
      { group: "xp", field: "dailyWordXp", from: 50, to: 0 },
      { group: "xp", field: "goldXp", from: 300, to: 400 },
    ]);
    for (const [group, field, value] of [
      ["xp", "goldXp", "-1"],
      ["xp", "goldXp", "1001"],
      ["xp", "dailyRightXp", "201"],
      ["xp", "questXp", "1.5"],
    ] as const) {
      const bad = checkAmounts({ ...draft, [group]: { ...draft[group], [field]: value } });
      expect(!bad.ok && bad.fields.has(`${group}.${field}`), `${field} ${value}`).toBe(true);
    }
  });

  it("lists what a revert puts back, and nothing when the API names no earlier amounts", () => {
    expect(revertChanges(row)).toEqual([]);
    const earlier = { xp: { ...row.xp, questXp: 80, goldXp: 250 } };
    expect(revertChanges({ ...row, previous: earlier, revertible: true })).toEqual([
      { group: "xp", field: "questXp", from: 100, to: 80 },
      { group: "xp", field: "goldXp", from: 300, to: 250 },
    ]);
  });

  it("has words for every amount", () => {
    for (const field of XP_AMOUNTS)
      expect(Object.hasOwn(MESSAGES, amountLabel("xp", field))).toBe(true);
    expect(readAmounts(row)).toEqual(row);
    expect(readAmounts({ ...row, extra: 1 })).toBeUndefined();
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
