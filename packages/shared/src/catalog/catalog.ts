import { z } from "zod";
import { TEMPLATE_KEY, templateBodySchema } from "#src/templates/template";
import { arabicText, englishText } from "#src/text/bilingual";

/**
 * The console's catalog editors (T-709b, FR-1403): event templates, achievements, level titles and the gem shop. Each
 * editor changes configuration the platform already reads. A saved change is an audit entry holding the edited fields
 * before and after (`CatalogDoc`), and the same shape is what a revert puts back, so one schema guards a save and a revert.
 */
export const CATALOG_KINDS = ["template", "achievement", "level_titles", "gem_shop"] as const;
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

const threshold = z.number().int().min(1).max(100_000);

/**
 * What an admin edits of an achievement: the name. The tier thresholds are listed, never edited here: a lower threshold makes
 * questify_sync pay gems to every player who now reaches the tier, and a revert cannot take them back (T-709c).
 */
export const achievementDocSchema = z.strictObject({ name: pair(60) });
export type AchievementDoc = z.infer<typeof achievementDocSchema>;

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

/** The issues of a template body that fails the schema, as short lines for the editor ("categories.0.quests.2.points: ..."). */
export function templateBodyIssues(body: unknown): string[] {
  const parsed = templateBodySchema.safeParse(body);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`);
}
