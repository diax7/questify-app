import { describe, expect, it } from "vitest";
import {
  templateBodySchema,
  templateRowSchema,
  templateTotals,
  templateViewOf,
  templateViewSchema,
  type TemplateBody,
} from "#src/templates/template";

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
const reward = {
  kind: "experience",
  nameAr: "جولة",
  nameEn: "Tour",
  descriptionAr: "جولة خلف الكواليس.",
  descriptionEn: "A backstage tour.",
  price: 300,
  perPlayerLimit: null,
  section: null,
  tagNew: false,
  tagLimited: false,
};
const body = (): TemplateBody =>
  ({
    config: { features: {}, accent: "sky", layoutPreset: "classic" },
    categories: [
      { nameAr: "البداية", nameEn: "Start", orderMode: "any", completionBonus: 0, quests: [quest] },
    ],
    rewards: [reward],
  }) as TemplateBody;

const category = (index: number) => ({
  nameAr: "فئة",
  nameEn: `Group ${index}`,
  orderMode: "any",
  completionBonus: 0,
  quests: Array.from({ length: 15 }, () => quest),
});
const row = () => ({
  key: "festival",
  name: { ar: "مهرجان", en: "Festival" },
  description: { ar: "يوم طويل.", en: "A long day." },
  body: body(),
});

/** The body with one change, as plain data so a test can break any part of it. */
const changed = (change: (draft: Record<string, any>) => void): unknown => {
  const draft = structuredClone(body()) as unknown as Record<string, any>;
  change(draft);
  return draft;
};

describe("template body", () => {
  it("accepts a template with a quest and a reward", () => {
    expect(templateBodySchema.safeParse(body()).success).toBe(true);
  });

  it.each([
    [
      "a quiz, which needs facts the template cannot know",
      (d: any) => (d["categories"][0].quests[0].type = "quiz"),
    ],
    ["an item reward, which needs the prize desk", (d: any) => (d["rewards"][0].kind = "item")],
    ["a platform-only switch", (d: any) => (d["config"].features = { dailyWord: false })],
    ["an add-on switch", (d: any) => (d["config"].features = { bigScreen: true })],
    ["an unknown switch", (d: any) => (d["config"].features = { teleport: true })],
    ["an accent outside the list", (d: any) => (d["config"].accent = "#ff0000")],
    ["a layout preset that does not exist", (d: any) => (d["config"].layoutPreset = "wild")],
    [
      "a one-try quest that repeats",
      (d: any) => {
        d["categories"][0].quests[0] = {
          ...quest,
          type: "share",
          typeConfig: { message: { ar: "نص", en: "Text" } },
          repeatCap: 3,
        };
      },
    ],
    [
      "a config that is not in its stored form",
      (d: any) => (d["categories"][0].quests[0] = { ...quest, type: "submission", typeConfig: {} }),
    ],
    [
      "a config with a field the type does not have",
      (d: any) => (d["categories"][0].quests[0].typeConfig = { code: "ABCD" }),
    ],
    ["Arabic-Indic digits", (d: any) => (d["categories"][0].quests[0].titleAr = "زر الجناح ١")],
    ["an Arabic title in English", (d: any) => (d["categories"][0].quests[0].titleEn = "سجّل")],
    ["an English title in Arabic", (d: any) => (d["rewards"][0].nameAr = "Tour")],
    ["a blank text", (d: any) => (d["categories"][0].nameEn = "  ")],
    ["a negative price", (d: any) => (d["rewards"][0].price = 0)],
    ["a field the schema does not know", (d: any) => (d["rewards"][0].stock = 20)],
    ["no category", (d: any) => (d["categories"] = [])],
    ["an empty category", (d: any) => (d["categories"][0].quests = [])],
    [
      "too many rewards",
      (d: any) => (d["rewards"] = Array.from({ length: 13 }, () => d["rewards"][0])),
    ],
    [
      "a bidi control character",
      (d: any) => (d["categories"][0].nameAr = `البداية${String.fromCodePoint(0x202e)}`),
    ],
  ])("refuses %s", (_name, change) => {
    expect(templateBodySchema.safeParse(changed(change)).success).toBe(false);
  });

  it("refuses a quest whose type switch the same template turns off", () => {
    const meet = {
      ...quest,
      type: "meet",
      repeatCap: 5,
      typeConfig: { dailyCap: 5 },
    };
    const withMeet = (features: Record<string, boolean>) =>
      changed((d) => {
        d["categories"][0].quests[0] = meet;
        d["config"].features = features;
      });
    expect(templateBodySchema.safeParse(withMeet({})).success).toBe(true);
    expect(templateBodySchema.safeParse(withMeet({ meetSomeone: false })).success).toBe(false);
  });

  it("limits the number of quests across categories", () => {
    const many = changed((d) => (d["categories"] = [category(1), category(2), category(3)]));
    expect(templateBodySchema.safeParse(many).success).toBe(false);
  });
});

describe("template row and view", () => {
  it.each(["Festival", "1festival", "f", "has space", "a".repeat(31)])(
    "refuses the key %s",
    (key) => {
      expect(templateRowSchema.safeParse({ ...row(), key }).success).toBe(false);
    },
  );

  it("shows the picker the names, counts and switches and nothing a player would not see", () => {
    const view = templateViewOf(templateRowSchema.parse(row()));
    expect(templateViewSchema.parse(view)).toEqual(view);
    expect(templateTotals(view)).toEqual({ categories: 1, quests: 1, rewards: 1 });
    expect(view.categories[0]?.quests[0]).toEqual({
      type: "scan_qr",
      title: { ar: "سجّل حضورك", en: "Check in" },
      points: 50,
    });
    expect(JSON.stringify(view)).not.toContain("typeConfig");
    expect(JSON.stringify(view)).not.toContain("امسح الرمز");
  });
});
