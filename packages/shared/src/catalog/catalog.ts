import { z } from "zod";
import { catalogPair as pair } from "#src/catalog/catalog-pair";
import { checkPlayerIntro } from "#src/layout/player-intro";
import { checkQuestifyHome } from "#src/layout/questify-home";
import { TEMPLATE_KEY, templateBodySchema } from "#src/templates/template";

/**
 * The console's catalog editors (T-709b, T-709c, T-709d, FR-1403): event templates, achievements, level titles,
 * the XP amounts, the XP table with its level rewards, and Questify's items (`xp-table.ts`). Each editor changes configuration the platform already reads. A saved change is an audit entry holding the edited fields
 * before and after (`CatalogDoc`), and the same shape is what a revert puts back, so one schema guards a save and a revert.
 */
export const CATALOG_KINDS = [
  "template",
  "achievement",
  "level_titles",
  "amounts",
  "xp_table",
  "item",
  "home_layout",
  "player_intro",
] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

/**
 * The most bytes a template body may hold as JSON text (UTF-8): the audit entry of a change holds it twice, and an audit
 * column stays under 64 KB. The database refuses a body over 60,000 stored bytes (migration 0119), which this leaves room for.
 */
export const TEMPLATE_BODY_MAX_BYTES = 30_000;

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

export const ACHIEVEMENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const ITEM_ID = /^[a-z][a-z0-9-]{0,63}$/;
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

const ACHIEVEMENT_TIERS = ["bronze", "silver", "gold"] as const;

/** The item an achievement unlocks, at the tier the admin picks (T-404c, ADR-765). */
export const achievementItemSchema = z.strictObject({
  tier: z.enum(ACHIEVEMENT_TIERS),
  itemId: z.string().regex(ITEM_ID),
});
export type AchievementItem = z.infer<typeof achievementItemSchema>;

/**
 * What an admin edits of an achievement (T-709c, T-404c): the name, the three tier thresholds, whole and strictly rising,
 * and the optional item (left out, it is unchanged; null removes it). A
 * lower threshold makes questify_sync pay XP and the tier's item to every player who now reaches the tier, and a revert
 * cannot take them back, so the API refuses a lowering until the admin confirms it (409 `confirmation_required`).
 */
export const achievementDocSchema = z
  .strictObject({
    name: pair(60),
    bronze: threshold,
    silver: threshold,
    gold: threshold,
    item: achievementItemSchema.nullable().optional(),
  })
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
 * revert keeps the thresholds in force; entries from before T-404c hold no item, and their revert keeps it.
 */
export const achievementBeforeSchema = z.strictObject({
  name: pair(60),
  bronze: threshold.optional(),
  silver: threshold.optional(),
  gold: threshold.optional(),
  item: achievementItemSchema.nullable().optional(),
});

const loweredTier = z.strictObject({
  xp: z.number().int().min(0),
  itemId: z.string().regex(ITEM_ID).nullable(),
});

/** What a lowering pays now, per lowered tier: the `details.tiers` of a 409 `confirmation_required`. */
export const loweredTiersSchema = z.strictObject({
  bronze: loweredTier.optional(),
  silver: loweredTier.optional(),
  gold: loweredTier.optional(),
});
export type LoweredTiers = z.infer<typeof loweredTiersSchema>;

/**
 * The XP amounts (T-709c, T-404c; ADR-438, ADR-764), each a whole number in its range: quest XP, the daily XP and the XP of
 * each achievement tier. The database's CHECK holds the same ranges (migration 0163).
 */
export const AMOUNT_RANGES = {
  xp: {
    questXp: [1, 99_999],
    dailyFinishXp: [0, 400],
    dailyRightXp: [0, 200],
    dailyWordXp: [0, 1000],
    bronzeXp: [0, 1000],
    silverXp: [0, 1000],
    goldXp: [0, 1000],
  },
} as const;
export type AmountGroup = keyof typeof AMOUNT_RANGES;
export const XP_AMOUNTS = [
  "questXp",
  "dailyFinishXp",
  "dailyRightXp",
  "dailyWordXp",
  "bronzeXp",
  "silverXp",
  "goldXp",
] as const;

const amount = (range: readonly [number, number]) => z.number().int().min(range[0]).max(range[1]);
const xpAmounts = z.strictObject({
  questXp: amount(AMOUNT_RANGES.xp.questXp),
  dailyFinishXp: amount(AMOUNT_RANGES.xp.dailyFinishXp),
  dailyRightXp: amount(AMOUNT_RANGES.xp.dailyRightXp),
  dailyWordXp: amount(AMOUNT_RANGES.xp.dailyWordXp),
  bronzeXp: amount(AMOUNT_RANGES.xp.bronzeXp),
  silverXp: amount(AMOUNT_RANGES.xp.silverXp),
  goldXp: amount(AMOUNT_RANGES.xp.goldXp),
});

/** The amounts as one document: what a save sends and an audit entry holds. */
export const amountsDocSchema = z.strictObject({ xp: xpAmounts });
export type AmountsDoc = z.infer<typeof amountsDocSchema>;

/**
 * The `before` of an amounts audit entry, which a revert puts back: entries from before T-404c hold a `gems` group, which
 * the door drops, and no tier XP, which it keeps as it stands now.
 */
export const amountsBeforeSchema = z.strictObject({
  xp: xpAmounts.partial({ bronzeXp: true, silverXp: true, goldXp: true }),
  gems: z.record(z.string(), z.number()).optional(),
});

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
  stored: z.strictObject({ xp: z.boolean() }),
  /** What a revert would put back (the latest entry's `before`, tiers filled in), when there is one that reads. */
  previous: z.strictObject({ xp: xpAmounts }).optional(),
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
  item: achievementItemSchema.nullable(),
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

export const templatesAdminListSchema = z.strictObject({ templates: z.array(templateAdminSchema) });
export const templateAdminAnswerSchema = z.strictObject({ template: templateAdminSchema });
export const achievementsAdminListSchema = z.strictObject({
  achievements: z.array(achievementAdminSchema),
});
export const achievementAdminAnswerSchema = z.strictObject({ achievement: achievementAdminSchema });

/**
 * What an admin edits of Questify home (T-713, FR-1838): the order, the hidden blocks and the banner's slides. The check is the
 * shared one (`checkQuestifyHome`): every block once, none of the protected ones hidden, at most five clean text slides. A save
 * and a revert both go through it, and the database's door checks the same rules again (migration 0137).
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

/**
 * What an admin edits of the player intro (T-802b, FR-1803): the order of the cards and the hidden ones. The check is the shared
 * one (`checkPlayerIntro`): every card once, at least one left shown. A save and a revert both go through it, and the database's
 * door checks the same rules again (migration 0145).
 */
export const playerIntroDocSchema = z.unknown().transform((value, context) => {
  const checked = checkPlayerIntro(value);
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

/** The intro in force as the console lists it; read again with `readPlayerIntro`, which also repairs it. */
export const playerIntroAdminSchema = z.strictObject({
  order: z.array(z.string()),
  hidden: z.array(z.string()),
  revertible,
});
export type PlayerIntroAdmin = z.infer<typeof playerIntroAdminSchema>;

/** The issues of a template body that fails the schema, as short lines for the editor ("categories.0.quests.2.points: ..."). */
export function templateBodyIssues(body: unknown): string[] {
  const parsed = templateBodySchema.safeParse(body);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`);
}
