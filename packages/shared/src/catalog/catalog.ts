import { z } from "zod";
import { checkQuestifyHome } from "#src/layout/questify-home";
import { TEMPLATE_KEY, templateBodySchema } from "#src/templates/template";
import { arabicText, englishText } from "#src/text/bilingual";

/**
 * The console's catalog editors (T-709b, T-709c, T-709d, FR-1403): event templates, achievements, level titles, the gem
 * shop, the XP and gem amounts, the XP table with its level rewards, and Questify's items (`xp-table.ts`). Each editor changes configuration the platform already reads. A saved change is an audit entry holding the edited fields
 * before and after (`CatalogDoc`), and the same shape is what a revert puts back, so one schema guards a save and a revert.
 */
export const CATALOG_KINDS = [
  "template",
  "achievement",
  "level_titles",
  "gem_shop",
  "amounts",
  "xp_table",
  "item",
  "home_layout",
] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

/**
 * The most bytes a template body may hold as JSON text (UTF-8): the audit entry of a change holds it twice, and an audit
 * column stays under 64 KB. The database refuses a body over 60,000 stored bytes (migration 0119), which this leaves room for.
 */
export const TEMPLATE_BODY_MAX_BYTES = 30_000;

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const pair = (max: number) => z.strictObject({ ar: arabicText(max), en: englishText(max) });

export const ACHIEVEMENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const ITEM_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const GEM_SHOP_STATUSES = ["active", "retired"] as const;
export const LEVEL_TITLE_LIMIT = 100;

/** What an admin edits of a template. */
export const templateDocSchema = z.strictObject({
  name: pair(120),
  description: pair(300),
  body: templateBodySchema.superRefine((body, context) => {
    const bytes = utf8Bytes(JSON.stringify(body));
    if (bytes > TEMPLATE_BODY_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        message: `the setup is ${bytes} bytes and at most ${TEMPLATE_BODY_MAX_BYTES} can be saved (every change is kept twice in the audit log)`,
      });
    }
  }),
  enabled: z.boolean(),
});
export type TemplateDoc = z.infer<typeof templateDocSchema>;

export const THRESHOLD_MAX = 100_000;
const threshold = z.number().int().min(1).max(THRESHOLD_MAX);

/**
 * What an admin edits of an achievement (T-709c): the name and the three tier thresholds, whole and strictly rising. A
 * lower threshold makes questify_sync pay gems to every player who now reaches the tier, and a revert cannot take them
 * back, so the API refuses a lowering until the admin confirms it (409 `confirmation_required`).
 */
export const achievementDocSchema = z
  .strictObject({ name: pair(60), bronze: threshold, silver: threshold, gold: threshold })
  .superRefine((doc, context) => {
    if (!(doc.bronze < doc.silver && doc.silver < doc.gold)) {
      context.addIssue({
        code: "custom",
        path: ["thresholds"],
        message: "the thresholds must rise from bronze to gold",
      });
    }
  });
export type AchievementDoc = z.infer<typeof achievementDocSchema>;

/**
 * The `before` of an achievement's audit entry, which a revert puts back: T-709b's entries hold the name only, and their
 * revert keeps the thresholds in force.
 */
export const achievementBeforeSchema = z.strictObject({
  name: pair(60),
  bronze: threshold.optional(),
  silver: threshold.optional(),
  gold: threshold.optional(),
});

/** What a lowering pays now, per lowered tier: the `details.gems` of a 409 `confirmation_required`. */
export const loweredGemsSchema = z.strictObject({
  bronze: z.number().int().min(1).optional(),
  silver: z.number().int().min(1).optional(),
  gold: z.number().int().min(1).optional(),
});
export type LoweredGems = z.infer<typeof loweredGemsSchema>;

/**
 * The XP and gem amounts (T-709c, ADR-438), each a whole number in its range: quest XP, the daily XP, and the gems of a
 * level and of each achievement tier. The database's CHECKs hold the same ranges (migration 0122).
 */
export const AMOUNT_RANGES = {
  xp: {
    questXp: [1, 99_999],
    dailyFinishXp: [0, 400],
    dailyRightXp: [0, 200],
    dailyWordXp: [0, 1000],
  },
  gems: { levelUp: [1, 1000], bronze: [1, 1000], silver: [1, 1000], gold: [1, 1000] },
} as const;
export type AmountGroup = keyof typeof AMOUNT_RANGES;
export const XP_AMOUNTS = ["questXp", "dailyFinishXp", "dailyRightXp", "dailyWordXp"] as const;
export const GEM_AMOUNTS = ["levelUp", "bronze", "silver", "gold"] as const;

const amount = (range: readonly [number, number]) => z.number().int().min(range[0]).max(range[1]);
const xpAmounts = z.strictObject({
  questXp: amount(AMOUNT_RANGES.xp.questXp),
  dailyFinishXp: amount(AMOUNT_RANGES.xp.dailyFinishXp),
  dailyRightXp: amount(AMOUNT_RANGES.xp.dailyRightXp),
  dailyWordXp: amount(AMOUNT_RANGES.xp.dailyWordXp),
});
const gemAmounts = z.strictObject({
  levelUp: amount(AMOUNT_RANGES.gems.levelUp),
  bronze: amount(AMOUNT_RANGES.gems.bronze),
  silver: amount(AMOUNT_RANGES.gems.silver),
  gold: amount(AMOUNT_RANGES.gems.gold),
});

/** The amounts as one document: what a save sends, an audit entry holds and a revert puts back. */
export const amountsDocSchema = z.strictObject({ xp: xpAmounts, gems: gemAmounts });
export type AmountsDoc = z.infer<typeof amountsDocSchema>;

const levelTitle = z.strictObject({
  levelFrom: z.number().int().min(1).max(LEVEL_TITLE_LIMIT),
  name: pair(40),
});

/** The whole set of level titles: a title covers the levels from its own up to the next one's, so level 1 must have one. */
export const levelTitlesDocSchema = z
  .strictObject({ titles: z.array(levelTitle).min(1).max(LEVEL_TITLE_LIMIT) })
  .superRefine((doc, context) => {
    const levels = doc.titles.map((title) => title.levelFrom);
    if (!levels.includes(1)) {
      context.addIssue({ code: "custom", path: ["titles"], message: "level 1 needs a title" });
    }
    if (new Set(levels).size !== levels.length) {
      context.addIssue({ code: "custom", path: ["titles"], message: "a level has two titles" });
    }
  });
export type LevelTitlesDoc = z.infer<typeof levelTitlesDocSchema>;

/** What an admin edits of a gem shop item: price, whether it is on sale, and its place in the shop. */
export const gemShopDocSchema = z.strictObject({
  price: z.number().int().min(1).max(100_000),
  status: z.enum(GEM_SHOP_STATUSES),
  position: z.number().int().min(1).max(1000),
});
export type GemShopDoc = z.infer<typeof gemShopDocSchema>;

const revertible = z.boolean();

/**
 * A template as the console lists it, switched off ones included. The body is not checked here: a stored body that fails
 * `templateBodySchema` must still show, so an admin can fix it.
 */
export const templateAdminSchema = z.strictObject({
  key: z.string().regex(TEMPLATE_KEY),
  position: z.number().int().min(1),
  name: z.strictObject({ ar: z.string(), en: z.string() }),
  description: z.strictObject({ ar: z.string(), en: z.string() }),
  body: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  updatedAt: z.string(),
  revertible,
});
export type TemplateAdmin = z.infer<typeof templateAdminSchema>;

/** The amounts in force (fallbacks filled in), and whether each setting row is stored yet. */
export const amountsAdminSchema = z.strictObject({
  xp: xpAmounts,
  gems: gemAmounts,
  stored: z.strictObject({ xp: z.boolean(), gems: z.boolean() }),
  revertible,
});
export type AmountsAdmin = z.infer<typeof amountsAdminSchema>;

export const achievementAdminSchema = z.strictObject({
  id: z.string().regex(ACHIEVEMENT_ID),
  metric: z.enum(["events", "quests", "cities", "top10", "goals"]),
  bronze: threshold,
  silver: threshold,
  gold: threshold,
  name: z.strictObject({ ar: z.string(), en: z.string() }),
  visualKey: z.string(),
  position: z.number().int().min(1),
  revertible,
});
export type AchievementAdmin = z.infer<typeof achievementAdminSchema>;

export const levelTitlesAdminSchema = z.strictObject({
  titles: z.array(
    z.strictObject({
      levelFrom: z.number().int().min(1),
      name: z.strictObject({ ar: z.string(), en: z.string() }),
    }),
  ),
  revertible,
});
export type LevelTitlesAdmin = z.infer<typeof levelTitlesAdminSchema>;

export const gemShopItemAdminSchema = z.strictObject({
  itemId: z.string().regex(ITEM_ID),
  kind: z.enum(["character", "frame", "title"]),
  name: z.strictObject({ ar: z.string(), en: z.string() }),
  visualKey: z.string().nullable(),
  price: z.number().int().min(1),
  status: z.enum(GEM_SHOP_STATUSES),
  position: z.number().int().min(1),
  revertible,
});
export type GemShopItemAdmin = z.infer<typeof gemShopItemAdminSchema>;

export const templatesAdminListSchema = z.strictObject({ templates: z.array(templateAdminSchema) });
export const templateAdminAnswerSchema = z.strictObject({ template: templateAdminSchema });
export const achievementsAdminListSchema = z.strictObject({
  achievements: z.array(achievementAdminSchema),
});
export const achievementAdminAnswerSchema = z.strictObject({ achievement: achievementAdminSchema });
export const gemShopAdminListSchema = z.strictObject({ items: z.array(gemShopItemAdminSchema) });
export const gemShopItemAdminAnswerSchema = z.strictObject({ item: gemShopItemAdminSchema });

/**
 * What an admin edits of Questify home (T-713, FR-1838): the order, the hidden blocks and the banner's slides. The check is the
 * shared one (`checkQuestifyHome`): every block once, none of the protected ones hidden, at most five clean text slides. A save
 * and a revert both go through it, and the database's door checks the same rules again (migration 0132).
 */
export const homeLayoutDocSchema = z.unknown().transform((value, context) => {
  const checked = checkQuestifyHome(value);
  if (checked.ok) {
    return checked.value;
  }
  for (const issue of checked.issues) {
    context.addIssue({
      code: "custom",
      path: issue.path === "" ? [] : issue.path.split("."),
      message: issue.message,
    });
  }
  return z.NEVER;
});

/**
 * The layout in force as the console lists it. The lists are read again with `readQuestifyHome`, which also repairs them, so
 * a stored slide that no longer passes the check still shows and can be fixed.
 */
export const homeLayoutAdminSchema = z.strictObject({
  order: z.array(z.string()),
  hidden: z.array(z.string()),
  banner: z.array(z.unknown()),
  revertible,
});
export type HomeLayoutAdmin = z.infer<typeof homeLayoutAdminSchema>;

/** The issues of a template body that fails the schema, as short lines for the editor ("categories.0.quests.2.points: ..."). */
export function templateBodyIssues(body: unknown): string[] {
  const parsed = templateBodySchema.safeParse(body);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`);
}
