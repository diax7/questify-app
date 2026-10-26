import type { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  QUESTIFY_METRICS,
  adminCampaignSchema,
  adminQuestSchema,
  adminQuestifySchema,
  campaignBodySchema,
  levelUpSchema,
  questBodySchema,
  questPatchSchema,
  questifyQuestSchema,
  questifyQuestsSchema,
  questifySyncSchema,
} from "#src/questify/quests";

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
const text = (length: number) => "a".repeat(length);
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const title = { ar: "ثلاث فعاليات", en: "Three events" };
const stamp = "2030-01-01T10:00:00.000Z";
const item = {
  id: "frame-01",
  kind: "frame",
  name: { ar: "إطار", en: "Frame" },
  visualKey: "frame-01",
};

const sync = {
  achievements: [{ id: "regular", tier: "bronze" }],
  quests: [{ id: UUID, title, xp: 50 }],
  levelUp: { level: 2, title, items: [] },
};
const syncWithAchievement = (achievement: Record<string, unknown>) => ({
  ...sync,
  achievements: [{ id: "regular", tier: "gold", ...achievement }],
});
const syncWithQuest = (change: Record<string, unknown>) => ({
  ...sync,
  quests: [{ id: UUID, title, xp: 50, ...change }],
});

describe("QUESTIFY_METRICS", () => {
  it("is the closed list of what a quest counts", () => {
    expect(QUESTIFY_METRICS).toEqual(["events", "cities", "quests"]);
  });
});

describe("levelUpSchema", () => {
  const levelUp = { level: 3, title, items: [item] };

  it("keeps the level, its title and its items", () => {
    expect(levelUpSchema.parse(levelUp)).toEqual(levelUp);
    expect(levelUpSchema.parse({ ...levelUp, items: [] })).toEqual({ ...levelUp, items: [] });
  });

  it("takes a level from 2 up as a whole number", () => {
    for (const level of [2, 3, 50])
      expect(accepts(levelUpSchema, { ...levelUp, level })).toBe(true);
    for (const level of [1, 0, -2, 2.5, "3", undefined])
      expect(accepts(levelUpSchema, { ...levelUp, level })).toBe(false);
  });

  it("needs a bilingual title and items that are items", () => {
    for (const value of [{ ar: "x" }, { en: "x" }, undefined])
      expect(accepts(levelUpSchema, { ...levelUp, title: value })).toBe(false);
    expect(accepts(levelUpSchema, { ...levelUp, items: [{ id: "frame-01" }] })).toBe(false);
    expect(accepts(levelUpSchema, { ...levelUp, items: undefined })).toBe(false);
  });
});

describe("questifySyncSchema", () => {
  it("keeps the tiers, the quests paid and the level reached", () => {
    expect(questifySyncSchema.parse(sync)).toEqual(sync);
  });

  it("keeps an empty answer with no level reached", () => {
    const empty = { achievements: [], quests: [], levelUp: null };
    expect(questifySyncSchema.parse(empty)).toEqual(empty);
  });

  it("bounds an achievement id to 1..64 characters and takes only the three tiers", () => {
    for (const id of [text(1), text(64)])
      expect(accepts(questifySyncSchema, syncWithAchievement({ id }))).toBe(true);
    for (const id of ["", text(65), 7])
      expect(accepts(questifySyncSchema, syncWithAchievement({ id }))).toBe(false);
    for (const tier of ["platinum", null, undefined])
      expect(accepts(questifySyncSchema, syncWithAchievement({ tier }))).toBe(false);
  });

  it("needs a paid quest to have a UUID, a bilingual title and a positive whole xp", () => {
    expect(accepts(questifySyncSchema, syncWithQuest({ xp: 1 }))).toBe(true);
    for (const change of [
      { xp: 0 },
      { xp: -5 },
      { xp: 1.5 },
      { id: "7" },
      { title: { ar: "x" } },
      { title: undefined },
    ])
      expect(accepts(questifySyncSchema, syncWithQuest(change))).toBe(false);
  });

  it("refuses an answer missing a part", () => {
    for (const part of ["achievements", "quests", "levelUp"])
      expect(accepts(questifySyncSchema, { ...sync, [part]: undefined })).toBe(false);
  });
});

describe("questifyQuestSchema and questifyQuestsSchema", () => {
  const quest = {
    id: UUID,
    title,
    metric: "cities",
    target: 3,
    progress: 1,
    xp: 40,
    done: false,
  };

  it("keeps every field of a quest", () => {
    expect(questifyQuestSchema.parse(quest)).toEqual(quest);
  });

  it("names the three metrics and refuses any other", () => {
    for (const metric of QUESTIFY_METRICS)
      expect(questifyQuestSchema.parse({ ...quest, metric }).metric).toBe(metric);
    for (const metric of ["", "points", null, undefined])
      expect(accepts(questifyQuestSchema, { ...quest, metric })).toBe(false);
  });

  it("takes the target and xp as positive whole numbers and the progress from 0", () => {
    for (const change of [{ target: 1 }, { xp: 1 }, { progress: 0 }, { progress: 99 }])
      expect(accepts(questifyQuestSchema, { ...quest, ...change })).toBe(true);
    for (const change of [
      { target: 0 },
      { target: 1.5 },
      { xp: 0 },
      { xp: -1 },
      { progress: -1 },
      { progress: 0.5 },
    ])
      expect(accepts(questifyQuestSchema, { ...quest, ...change })).toBe(false);
  });

  it("needs a UUID id, a bilingual title and a boolean done", () => {
    for (const change of [{ id: "7" }, { title: { en: "x" } }, { done: "no" }, { done: undefined }])
      expect(accepts(questifyQuestSchema, { ...quest, ...change })).toBe(false);
  });

  it("keeps always-on quests and each running campaign with its quests", () => {
    const list = {
      alwaysOn: [quest],
      seasonal: [
        {
          campaign: { id: OTHER_UUID, name: title, endsAt: stamp },
          quests: [{ ...quest, done: true }],
        },
      ],
    };
    expect(questifyQuestsSchema.parse(list)).toEqual(list);
    expect(questifyQuestsSchema.parse({ alwaysOn: [], seasonal: [] })).toEqual({
      alwaysOn: [],
      seasonal: [],
    });
  });

  it("refuses a campaign without an id, a name or an end, and a quest that is malformed", () => {
    const campaign = { id: OTHER_UUID, name: title, endsAt: stamp };
    const seasonal = (change: Record<string, unknown>, quests: unknown[] = [quest]) => ({
      alwaysOn: [],
      seasonal: [{ campaign: { ...campaign, ...change }, quests }],
    });
    expect(accepts(questifyQuestsSchema, seasonal({}))).toBe(true);
    for (const change of [{ id: "7" }, { name: { ar: "x" } }, { endsAt: undefined }])
      expect(accepts(questifyQuestsSchema, seasonal(change))).toBe(false);
    expect(accepts(questifyQuestsSchema, seasonal({}, [{ id: UUID }]))).toBe(false);
    expect(accepts(questifyQuestsSchema, { alwaysOn: [{ id: UUID }], seasonal: [] })).toBe(false);
  });
});

describe("campaignBodySchema", () => {
  const body = {
    name: { ar: "موسم الشتاء", en: "Winter season" },
    startsAt: "2030-01-01T00:00:00+03:00",
    endsAt: "2030-02-01T00:00:00+03:00",
  };
  const named = (ar: string, en = "Winter") => ({ ...body, name: { ar, en } });

  it("keeps the names and the window as sent", () => {
    expect(campaignBodySchema.parse(body)).toEqual(body);
  });

  it("trims the names", () => {
    expect(campaignBodySchema.parse(named("  موسم  ", "\tWinter\n")).name).toEqual({
      ar: "موسم",
      en: "Winter",
    });
  });

  it("takes a name of 1 to 80 characters after trimming", () => {
    for (const value of [text(1), text(80), ` ${text(80)} `])
      expect(accepts(campaignBodySchema, named(value))).toBe(true);
    for (const value of ["", "   ", text(81)])
      expect(accepts(campaignBodySchema, named(value))).toBe(false);
    expect(accepts(campaignBodySchema, named("x", text(81)))).toBe(false);
  });

  it("needs both names and refuses any other key in the body or in the names", () => {
    expect(accepts(campaignBodySchema, { ...body, name: { ar: "x" } })).toBe(false);
    expect(accepts(campaignBodySchema, { ...body, name: { en: "x" } })).toBe(false);
    expect(accepts(campaignBodySchema, { ...body, name: { ar: "x", en: "y", fr: "z" } })).toBe(
      false,
    );
    expect(accepts(campaignBodySchema, { ...body, status: "draft" })).toBe(false);
    expect(accepts(campaignBodySchema, { startsAt: body.startsAt, endsAt: body.endsAt })).toBe(
      false,
    );
  });

  it.each([
    ["a NUL", "a\u0000b"],
    ["a line feed", "a\nb"],
    ["a tab", "a\tb"],
    ["a delete", "a\u007fb"],
    ["a C1 control", "a\u009fb"],
    ["a line separator", "a b"],
    ["a paragraph separator", "a b"],
    ["an embedding start", "a‪b"],
    ["a right-to-left override", "a‮b"],
    ["a middle bidi mark", "a‬b"],
    ["an isolate start", "a⁦b"],
    ["an isolate end", "a⁩b"],
    ["a middle isolate", "a⁧b"],
  ])("refuses a name holding %s and names the field and the reason", (_label, value) => {
    for (const language of ["ar", "en"] as const) {
      const name = { ar: "x", en: "y", [language]: value };
      const result = campaignBodySchema.safeParse({ ...body, name });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toHaveLength(1);
      expect(result.error?.issues[0]).toMatchObject({
        path: ["name", language],
        message: "must hold no control or direction characters",
      });
    }
  });

  it("keeps Arabic text, digits and the characters just outside the refused ranges", () => {
    for (const value of ["مرحبا بالعالم", "Season 2030", "a‧b", "a b", "a⁥b", "a‏b", "a b"])
      expect(accepts(campaignBodySchema, named(value))).toBe(true);
  });

  it("takes the window as instants with an offset or Z", () => {
    for (const startsAt of [
      "2030-01-01T00:00:00+03:00",
      "2030-01-01T00:00:00Z",
      "2030-01-01T00:00:00.123-05:00",
    ])
      expect(accepts(campaignBodySchema, { ...body, startsAt })).toBe(true);
    for (const endsAt of ["2030-02-01T00:00:00", "2030-02-01", "tomorrow", "", 20300201, undefined])
      expect(accepts(campaignBodySchema, { ...body, endsAt })).toBe(false);
    expect(accepts(campaignBodySchema, { ...body, startsAt: "2030-01-01T00:00:00" })).toBe(false);
  });
});

describe("questPatchSchema and questBodySchema", () => {
  const patch = { metric: "quests", target: 5, title, xp: 80, position: 2, status: "active" };
  const body = { ...patch, campaignId: UUID };
  const bounds: [string, number, number][] = [
    ["target", 1, 1000],
    ["xp", 1, 10000],
    ["position", 1, 1000],
  ];

  it("keeps every field of a patch and of a body", () => {
    expect(questPatchSchema.parse(patch)).toEqual(patch);
    expect(questBodySchema.parse(body)).toEqual(body);
    expect(questBodySchema.parse({ ...body, campaignId: null })).toEqual({
      ...body,
      campaignId: null,
    });
  });

  it.each(bounds)("takes the %s as a whole number from %i to %i", (field, min, max) => {
    for (const value of [min, max, Math.round((min + max) / 2)])
      expect(accepts(questPatchSchema, { ...patch, [field]: value })).toBe(true);
    for (const value of [min - 1, max + 1, 1.5, "7", null, undefined])
      expect(accepts(questPatchSchema, { ...patch, [field]: value })).toBe(false);
  });

  it("names the three metrics and refuses any other", () => {
    for (const metric of QUESTIFY_METRICS)
      expect(accepts(questPatchSchema, { ...patch, metric })).toBe(true);
    for (const metric of ["", "points", undefined])
      expect(accepts(questPatchSchema, { ...patch, metric })).toBe(false);
  });

  it("lets a console write only a draft or an active status", () => {
    for (const status of ["draft", "active"])
      expect(questPatchSchema.parse({ ...patch, status }).status).toBe(status);
    for (const status of ["", "retired", "published", undefined])
      expect(accepts(questPatchSchema, { ...patch, status })).toBe(false);
  });

  it("trims the title and holds it to 1..80 characters without direction characters", () => {
    expect(questPatchSchema.parse({ ...patch, title: { ar: " x ", en: " y " } }).title).toEqual({
      ar: "x",
      en: "y",
    });
    expect(accepts(questPatchSchema, { ...patch, title: { ar: text(80), en: text(1) } })).toBe(
      true,
    );
    for (const value of [
      { ar: "", en: "y" },
      { ar: "x", en: text(81) },
      { ar: "x", en: "a‮b" },
    ])
      expect(accepts(questPatchSchema, { ...patch, title: value })).toBe(false);
  });

  it("refuses an unknown key, and a patch cannot move the quest to a campaign", () => {
    expect(accepts(questPatchSchema, { ...patch, extra: 1 })).toBe(false);
    expect(accepts(questPatchSchema, body)).toBe(false);
    expect(accepts(questBodySchema, { ...body, extra: 1 })).toBe(false);
  });

  it("needs a body to name its campaign by UUID, or null for an always-on quest", () => {
    expect(accepts(questBodySchema, patch)).toBe(false);
    for (const campaignId of ["7", 5, undefined])
      expect(accepts(questBodySchema, { ...body, campaignId })).toBe(false);
  });
});

describe("the console's reads", () => {
  const campaign = {
    id: UUID,
    name: title,
    startsAt: stamp,
    endsAt: stamp,
    status: "published",
    createdAt: stamp,
    updatedAt: stamp,
  };
  const quest = {
    id: OTHER_UUID,
    campaignId: UUID,
    metric: "events",
    target: 2000,
    title,
    xp: 0,
    position: -1,
    status: "retired",
    createdAt: stamp,
    updatedAt: stamp,
  };

  it("keeps every field of a campaign and names its three statuses", () => {
    expect(adminCampaignSchema.parse(campaign)).toEqual(campaign);
    for (const status of ["draft", "published", "retired"])
      expect(adminCampaignSchema.parse({ ...campaign, status }).status).toBe(status);
    for (const status of ["", "active", "stopped", undefined])
      expect(accepts(adminCampaignSchema, { ...campaign, status })).toBe(false);
  });

  it("needs a campaign to have a UUID, a bilingual name and its times", () => {
    for (const change of [
      { id: "7" },
      { name: { ar: "x" } },
      { startsAt: undefined },
      { endsAt: 1 },
      { createdAt: undefined },
      { updatedAt: undefined },
    ])
      expect(accepts(adminCampaignSchema, { ...campaign, ...change })).toBe(false);
  });

  it("keeps every field of a quest, in any campaign or none, and names its three statuses", () => {
    expect(adminQuestSchema.parse(quest)).toEqual(quest);
    expect(adminQuestSchema.parse({ ...quest, campaignId: null })).toEqual({
      ...quest,
      campaignId: null,
    });
    for (const status of ["draft", "active", "retired"])
      expect(adminQuestSchema.parse({ ...quest, status }).status).toBe(status);
    for (const status of ["", "published", undefined])
      expect(accepts(adminQuestSchema, { ...quest, status })).toBe(false);
  });

  it("needs a quest to have whole numbers, a metric and a bilingual title", () => {
    for (const change of [
      { id: "7" },
      { campaignId: "7" },
      { campaignId: undefined },
      { metric: "points" },
      { target: 1.5 },
      { xp: "5" },
      { position: 0.5 },
      { title: { en: "x" } },
      { createdAt: undefined },
    ])
      expect(accepts(adminQuestSchema, { ...quest, ...change })).toBe(false);
  });

  it("keeps the always-on quests and the campaigns with their quests", () => {
    const list = {
      alwaysOn: [{ ...quest, campaignId: null }],
      campaigns: [{ ...campaign, quests: [quest] }],
    };
    expect(adminQuestifySchema.parse(list)).toEqual(list);
    expect(adminQuestifySchema.parse({ alwaysOn: [], campaigns: [] })).toEqual({
      alwaysOn: [],
      campaigns: [],
    });
  });

  it("refuses a campaign without its quests or with a malformed one", () => {
    expect(accepts(adminQuestifySchema, { alwaysOn: [], campaigns: [campaign] })).toBe(false);
    expect(
      accepts(adminQuestifySchema, {
        alwaysOn: [],
        campaigns: [{ ...campaign, quests: [{ id: UUID }] }],
      }),
    ).toBe(false);
    expect(accepts(adminQuestifySchema, { campaigns: [] })).toBe(false);
    expect(accepts(adminQuestifySchema, { alwaysOn: [] })).toBe(false);
  });
});
