import { z } from "zod";
import { REGISTRIES } from "#src/config/registry";
import { validateEventConfig } from "#src/config/validate";
import { ACCENT_KEYS, type AccentKey } from "#src/design/accents";
import { questTypeShown } from "#src/event/player-view";
import { LAYOUT_PRESETS } from "#src/layout/presets";
import { QUEST_TYPES, type QuestType } from "#src/quests/registry";

/**
 * The quest types a template may hold (T-601b, ADR-404): the ones whose content needs no fact the template cannot know. A
 * quiz needs right answers, a passport its steps, a location its place, a typed code its secret; the organizer adds those.
 */
export const TEMPLATE_QUEST_TYPES = [
  "scan_qr",
  "challenge",
  "submission",
  "vote",
  "survey",
  "share",
  "meet",
  "game",
] as const satisfies readonly QuestType[];
export type TemplateQuestType = (typeof TEMPLATE_QUEST_TYPES)[number];

/**
 * The reward kinds a template may hold. An item needs the prize desk's place (`reward_desk_guard`, FR-1716) and a new draft has
 * none; an experience or a digital reward does not. Both start with no stock (a digital reward's stock is its codes).
 */
export const TEMPLATE_REWARD_KINDS = ["experience", "digital"] as const;
export const TEMPLATE_REWARD_SECTIONS = ["featured", "merch", "food", "experiences"] as const;

/** The most a template may hold, so a pasted body cannot flood a new event. */
export const TEMPLATE_LIMITS = {
  categories: 8,
  questsPerCategory: 15,
  quests: 40,
  rewards: 12,
} as const;

const TEMPLATE_KEY = /^[a-z][a-z0-9_]{1,29}$/;
/** Digits of any other script clash with the Western digits every screen uses (ADR-018). */
const OTHER_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/;
const CONTROL = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const ARABIC_LETTER = /\p{Script=Arabic}/u;

const clean = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !OTHER_DIGITS.test(value) && !CONTROL.test(value), "Western digits only");
/** Arabic text holds an Arabic letter; a swapped language is caught here. */
const arabic = (max: number) =>
  clean(max).refine((value) => ARABIC_LETTER.test(value), "must be written in Arabic");
const english = (max: number) =>
  clean(max).refine((value) => !ARABIC_LETTER.test(value), "must be written in English");

const questSchema = z
  .strictObject({
    type: z.enum(TEMPLATE_QUEST_TYPES),
    titleAr: arabic(120),
    titleEn: english(120),
    descriptionAr: arabic(2000),
    descriptionEn: english(2000),
    points: z.number().int().min(0).max(100000),
    repeatCap: z.number().int().min(1).max(100),
    /** In the form the quest builder stores (`QUEST_TYPES[type].config` parses it to itself). */
    typeConfig: z.record(z.string(), z.unknown()),
  })
  .superRefine((quest, context) => {
    if (QUEST_TYPES[quest.type].oneTry && quest.repeatCap !== 1) {
      context.addIssue({
        code: "custom",
        path: ["repeatCap"],
        message: "a one-try type pays once",
      });
    }
    const parsed = QUEST_TYPES[quest.type].config.safeParse(quest.typeConfig);
    if (!parsed.success || canonical(parsed.data) !== canonical(quest.typeConfig)) {
      context.addIssue({
        code: "custom",
        path: ["typeConfig"],
        message: "must be the type's config in its stored form",
      });
    }
  });

/** A value as text with sorted keys, so two objects with the same content compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const categorySchema = z.strictObject({
  nameAr: arabic(120),
  nameEn: english(120),
  orderMode: z.enum(["any", "in_order"]),
  completionBonus: z.number().int().min(0).max(100000),
  quests: z.array(questSchema).min(1).max(TEMPLATE_LIMITS.questsPerCategory),
});

const rewardSchema = z.strictObject({
  kind: z.enum(TEMPLATE_REWARD_KINDS),
  nameAr: arabic(120),
  nameEn: english(120),
  descriptionAr: arabic(2000),
  descriptionEn: english(2000),
  price: z.number().int().min(1).max(1000000),
  perPlayerLimit: z.number().int().min(1).max(100).nullable(),
  section: z.enum(TEMPLATE_REWARD_SECTIONS).nullable(),
  tagNew: z.boolean(),
  tagLimited: z.boolean(),
});

const PRESET_IDS = LAYOUT_PRESETS.map((preset) => preset.id) as [string, ...string[]];

const configSchema = z
  .strictObject({
    /** Event switches by the feature registry's key; an event-level, ungated one only. */
    features: z.record(z.string(), z.boolean()),
    accent: z.enum(ACCENT_KEYS as [AccentKey, ...AccentKey[]]),
    layoutPreset: z.enum(PRESET_IDS),
  })
  .superRefine((config, context) => {
    const checked = validateEventConfig(REGISTRIES, { features: config.features });
    if (!checked.ok) {
      context.addIssue({
        code: "custom",
        path: ["features"],
        message: "unknown or platform-only switch",
      });
    }
    for (const key of Object.keys(config.features)) {
      if (REGISTRIES.features[key]?.gated === true) {
        context.addIssue({
          code: "custom",
          path: ["features", key],
          message: "an add-on is Questify's to unlock",
        });
      }
    }
  });

/**
 * What a template sets up (T-601b, FR-1015): switches, an accent and a layout preset, categories with their quests, and
 * rewards without stock. The `event_template` table stores it as `body`; the API checks it on every read and the Questify
 * console checks it before it saves a change.
 */
export const templateBodySchema = z
  .strictObject({
    config: configSchema,
    categories: z.array(categorySchema).min(1).max(TEMPLATE_LIMITS.categories),
    rewards: z.array(rewardSchema).max(TEMPLATE_LIMITS.rewards),
  })
  .superRefine((body, context) => {
    const quests = body.categories.flatMap((category) => category.quests);
    if (quests.length > TEMPLATE_LIMITS.quests) {
      context.addIssue({ code: "custom", path: ["categories"], message: "too many quests" });
    }
    const featureOn = (feature: string): boolean => body.config.features[feature] ?? true;
    for (const quest of quests) {
      if (!questTypeShown(quest.type, featureOn)) {
        context.addIssue({
          code: "custom",
          path: ["categories"],
          message: `a ${quest.type} quest needs its switch on`,
        });
      }
    }
  });
export type TemplateBody = z.infer<typeof templateBodySchema>;

const pair = z.strictObject({ ar: arabic(120), en: english(120) });
const description = z.strictObject({ ar: arabic(300), en: english(300) });

/** One enabled template as `event_templates()` answers it. */
export const templateRowSchema = z.strictObject({
  key: z.string().regex(TEMPLATE_KEY),
  name: pair,
  description,
  body: templateBodySchema,
});
export type TemplateRow = z.infer<typeof templateRowSchema>;

const questView = z.strictObject({
  type: z.enum(TEMPLATE_QUEST_TYPES),
  title: pair,
  points: z.number().int(),
});

/** What the picker shows of a template: no description of a quest, no config, nothing a player would not see. */
export const templateViewSchema = z.strictObject({
  key: z.string().regex(TEMPLATE_KEY),
  name: pair,
  description,
  categories: z.array(z.strictObject({ name: pair, quests: z.array(questView) })),
  rewards: z.array(
    z.strictObject({ kind: z.enum(TEMPLATE_REWARD_KINDS), name: pair, price: z.number().int() }),
  ),
  features: z.record(z.string(), z.boolean()),
  accent: z.enum(ACCENT_KEYS as [AccentKey, ...AccentKey[]]),
});
export type TemplateView = z.infer<typeof templateViewSchema>;

export const templateListSchema = z.strictObject({ templates: z.array(templateViewSchema) });
export type TemplateList = z.infer<typeof templateListSchema>;

/** The picker's view of a template row. */
export function templateViewOf(row: TemplateRow): TemplateView {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    categories: row.body.categories.map((category) => ({
      name: { ar: category.nameAr, en: category.nameEn },
      quests: category.quests.map((quest) => ({
        type: quest.type,
        title: { ar: quest.titleAr, en: quest.titleEn },
        points: quest.points,
      })),
    })),
    rewards: row.body.rewards.map((reward) => ({
      kind: reward.kind,
      name: { ar: reward.nameAr, en: reward.nameEn },
      price: reward.price,
    })),
    features: row.body.config.features,
    accent: row.body.config.accent,
  };
}

/** The counts a card shows: categories, quests and rewards. */
export function templateTotals(view: TemplateView): Readonly<{
  categories: number;
  quests: number;
  rewards: number;
}> {
  return {
    categories: view.categories.length,
    quests: view.categories.reduce((sum, category) => sum + category.quests.length, 0),
    rewards: view.rewards.length,
  };
}
