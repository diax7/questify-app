import {
  GEM_AMOUNTS,
  TEMPLATE_KEY,
  XP_AMOUNTS,
  achievementDocSchema,
  achievementsAdminListSchema,
  amountsAdminSchema,
  amountsDocSchema,
  loweredGemsSchema,
  gemShopAdminListSchema,
  gemShopDocSchema,
  levelTitlesAdminSchema,
  levelTitlesDocSchema,
  templateBodyIssues,
  templateDocSchema,
  templatesAdminListSchema,
  type AchievementAdmin,
  type AmountGroup,
  type AmountsAdmin,
  type AmountsDoc,
  type GemShopItemAdmin,
  type LoweredGems,
  type MessageKey,
  type LevelTitlesAdmin,
  type TemplateDoc,
  type TemplateAdmin,
} from "@questify/shared";

/** The console's catalog editors (T-709b, T-709c, FR-1403): templates, achievements, level titles, the shop, amounts. */
export const CATALOG_API = "/v1/admin/catalog";
export const TEMPLATES_API = `${CATALOG_API}/templates`;
export const ACHIEVEMENTS_API = `${CATALOG_API}/achievements`;
export const LEVEL_TITLES_API = `${CATALOG_API}/level-titles`;
export const GEM_SHOP_API = `${CATALOG_API}/gem-shop`;
export const AMOUNTS_API = `${CATALOG_API}/amounts`;

export const CATALOG_TABS = ["templates", "achievements", "levels", "shop", "amounts"] as const;
export type CatalogTab = (typeof CATALOG_TABS)[number];

/** The API path of one row of a catalog; every id is checked by the API's own pattern, and escaped all the same. */
export const rowPath = (base: string, id: string): string => `${base}/${encodeURIComponent(id)}`;
/** The API path that puts back what a row held before its latest change. */
export const revertPath = (base: string): string => `${base}/revert`;

/** Each reader answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readTemplates(body: unknown): TemplateAdmin[] | undefined {
  const parsed = templatesAdminListSchema.safeParse(body);
  return parsed.success ? parsed.data.templates : undefined;
}
export function readAchievements(body: unknown): AchievementAdmin[] | undefined {
  const parsed = achievementsAdminListSchema.safeParse(body);
  return parsed.success ? parsed.data.achievements : undefined;
}
export function readLevelTitles(body: unknown): LevelTitlesAdmin | undefined {
  const parsed = levelTitlesAdminSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}
export function readGemShop(body: unknown): GemShopItemAdmin[] | undefined {
  const parsed = gemShopAdminListSchema.safeParse(body);
  return parsed.success ? parsed.data.items : undefined;
}
export function readAmounts(body: unknown): AmountsAdmin | undefined {
  const parsed = amountsAdminSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The gems a lowering would pay, when the API refused it for want of a confirmation (409 `confirmation_required`), or
 * undefined for any other answer.
 */
export function loweredGemsOf(body: unknown): LoweredGems | undefined {
  const answer = body as { code?: unknown; details?: { gems?: unknown } } | null | undefined;
  if (answer?.code !== "confirmation_required") {
    return undefined;
  }
  const parsed = loweredGemsSchema.safeParse(answer.details?.gems);
  return parsed.success ? parsed.data : undefined;
}

/** The result of checking what an admin typed: the document to send, or the fields that are wrong. */
export type Checked<Doc> =
  | Readonly<{ ok: true; doc: Doc }>
  | Readonly<{ ok: false; fields: ReadonlySet<string>; messages: readonly string[] }>;

type Schema<Doc> = Readonly<{
  safeParse: (
    input: unknown,
  ) => { success: true; data: Doc } | { success: false; error: { issues: readonly Issue[] } };
}>;
type Issue = Readonly<{ path: readonly PropertyKey[]; message: string }>;

function checked<Doc>(schema: Schema<Doc>, input: unknown): Checked<Doc> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, doc: parsed.data };
  }
  return {
    ok: false,
    fields: new Set(parsed.error.issues.map((issue) => issue.path.map(String).join("."))),
    messages: parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join(".") || "body"}: ${issue.message}`,
    ),
  };
}

/** Whole numbers only: "12" is 12, "1.5", "" and "1e3" are not numbers the API takes. */
const wholeNumber = (text: string): number => (/^\d{1,9}$/.test(text.trim()) ? Number(text) : NaN);

// ---------------------------------------------------------------- event templates

export type Pair = Readonly<{ ar: string; en: string }>;

/** What the boxes of a template hold while an admin types. The setup is JSON text. */
export type TemplateDraft = Readonly<{
  key: string;
  name: Pair;
  description: Pair;
  enabled: boolean;
  body: string;
}>;

export const bodyText = (body: unknown): string => JSON.stringify(body, null, 2);

export const templateDraftOf = (row: TemplateAdmin): TemplateDraft => ({
  key: row.key,
  name: row.name,
  description: row.description,
  enabled: row.enabled,
  body: bodyText(row.body),
});

/** The draft of a template that does not exist yet: switched off, with the key still to be typed. */
export const newTemplateDraft = (from: TemplateAdmin | undefined): TemplateDraft => ({
  key: "",
  name: { ar: "", en: "" },
  description: { ar: "", en: "" },
  enabled: false,
  body: from === undefined ? "{}" : bodyText(from.body),
});

/** The JSON of the setup box, or undefined when it is not JSON. */
export function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether the key is one a template may have (lower-case words, digits and underscores). */
export const isTemplateKey = (key: string): boolean => TEMPLATE_KEY.test(key);

/** The edit document for a template draft, or the fields and lines that stop the save. */
export function checkTemplate(draft: TemplateDraft): Checked<TemplateDoc> {
  const body = parseBody(draft.body);
  if (body === undefined) {
    return { ok: false, fields: new Set(["body"]), messages: ["body: not valid JSON"] };
  }
  return checked(templateDocSchema, {
    name: draft.name,
    description: draft.description,
    enabled: draft.enabled,
    body,
  });
}

/** The lines that say why a stored setup is not valid, for a template an admin has to fix. */
export const storedBodyIssues = (row: TemplateAdmin): string[] => templateBodyIssues(row.body);

/** Whether the draft differs from the stored template. */
export const isTemplateDirty = (row: TemplateAdmin, draft: TemplateDraft): boolean => {
  const stored = templateDraftOf(row);
  return (
    draft.name.ar.trim() !== stored.name.ar ||
    draft.name.en.trim() !== stored.name.en ||
    draft.description.ar.trim() !== stored.description.ar ||
    draft.description.en.trim() !== stored.description.en ||
    draft.enabled !== stored.enabled ||
    draft.body.trim() !== stored.body
  );
};

/** The counts a template card shows, or undefined when the stored setup does not have the expected shape. */
export function templateCounts(
  row: TemplateAdmin,
): Readonly<{ categories: number; quests: number; rewards: number }> | undefined {
  const { categories, rewards } = row.body as { categories?: unknown; rewards?: unknown };
  if (!Array.isArray(categories) || !Array.isArray(rewards)) {
    return undefined;
  }
  const quests = categories.reduce<number>((sum, category: unknown) => {
    const list = (category as { quests?: unknown } | null)?.quests;
    return sum + (Array.isArray(list) ? list.length : 0);
  }, 0);
  return { categories: categories.length, quests, rewards: rewards.length };
}

// ---------------------------------------------------------------- achievements

export const TIERS = ["bronze", "silver", "gold"] as const;
type Tier = (typeof TIERS)[number];

/** An achievement's name and its three tier thresholds, as typed (T-709c). */
export type AchievementDraft = Readonly<{ name: Pair } & Record<Tier, string>>;

export const achievementDraftOf = (row: AchievementAdmin): AchievementDraft => ({
  name: row.name,
  bronze: String(row.bronze),
  silver: String(row.silver),
  gold: String(row.gold),
});

export const checkAchievement = (draft: AchievementDraft) =>
  checked(achievementDocSchema, {
    name: draft.name,
    bronze: wholeNumber(draft.bronze),
    silver: wholeNumber(draft.silver),
    gold: wholeNumber(draft.gold),
  });

export const isAchievementDirty = (row: AchievementAdmin, draft: AchievementDraft): boolean =>
  draft.name.ar.trim() !== row.name.ar ||
  draft.name.en.trim() !== row.name.en ||
  TIERS.some((tier) => draft[tier].trim() !== String(row[tier]));

// ---------------------------------------------------------------- the amounts

type Fields<Names extends readonly string[]> = Readonly<Record<Names[number], string>>;

/** The XP and gem amounts as typed (T-709c). */
export type AmountsDraft = Readonly<{
  xp: Fields<typeof XP_AMOUNTS>;
  gems: Fields<typeof GEM_AMOUNTS>;
}>;

const textOf = <Names extends readonly string[]>(
  names: Names,
  values: Readonly<Record<string, number>>,
): Fields<Names> =>
  Object.fromEntries(names.map((name) => [name, String(values[name])])) as Fields<Names>;
const numbersOf = (values: Readonly<Record<string, string>>): Record<string, number> =>
  Object.fromEntries(Object.entries(values).map(([name, text]) => [name, wholeNumber(text)]));

export const amountsDraftOf = (row: AmountsAdmin): AmountsDraft => ({
  xp: textOf(XP_AMOUNTS, row.xp),
  gems: textOf(GEM_AMOUNTS, row.gems),
});

export const checkAmounts = (draft: AmountsDraft) =>
  checked(amountsDocSchema, { xp: numbersOf(draft.xp), gems: numbersOf(draft.gems) });

/** The words of one amount; every amount has them (console-catalog.test). */
export const amountLabel = (group: AmountGroup, field: string): MessageKey =>
  `console.catalog.amounts.${group}.${field}` as MessageKey;

/** One amount the save changes, for the confirmation's lines. */
export type AmountChange = Readonly<{
  group: AmountGroup;
  field: string;
  from: number;
  to: number;
}>;

/** Every amount the document changes from the stored ones, XP first, each group in its own order. */
export function amountChanges(row: AmountsAdmin, doc: AmountsDoc): AmountChange[] {
  const of = (group: AmountGroup, names: readonly string[]): AmountChange[] =>
    names
      .map((field) => ({
        group,
        field,
        from: (row[group] as Readonly<Record<string, number>>)[field] ?? 0,
        to: (doc[group] as Readonly<Record<string, number>>)[field] ?? 0,
      }))
      .filter((change) => change.from !== change.to);
  return [...of("xp", XP_AMOUNTS), ...of("gems", GEM_AMOUNTS)];
}

// ---------------------------------------------------------------- level titles

export type LevelTitleDraft = Readonly<{ levelFrom: string; name: Pair }>;

export const levelTitlesDraftOf = (set: LevelTitlesAdmin): LevelTitleDraft[] =>
  set.titles.map((title) => ({ levelFrom: String(title.levelFrom), name: title.name }));

/** The titles in level order, so the list reads the way players climb it. */
export const byLevel = (titles: readonly LevelTitleDraft[]): LevelTitleDraft[] =>
  titles.toSorted((a, b) => (wholeNumber(a.levelFrom) || 0) - (wholeNumber(b.levelFrom) || 0));

export const checkLevelTitles = (titles: readonly LevelTitleDraft[]) =>
  checked(levelTitlesDocSchema, {
    titles: titles.map((title) => ({
      levelFrom: wholeNumber(title.levelFrom),
      name: title.name,
    })),
  });

export const isLevelTitlesDirty = (
  set: LevelTitlesAdmin,
  titles: readonly LevelTitleDraft[],
): boolean => JSON.stringify(levelTitlesDraftOf(set)) !== JSON.stringify(trimmed(titles));

const trimmed = (titles: readonly LevelTitleDraft[]): LevelTitleDraft[] =>
  titles.map((title) => ({
    levelFrom: title.levelFrom.trim(),
    name: { ar: title.name.ar.trim(), en: title.name.en.trim() },
  }));

// ---------------------------------------------------------------- the gem shop

export type ShopDraft = Readonly<{ price: string; status: "active" | "retired"; position: string }>;

export const shopDraftOf = (row: GemShopItemAdmin): ShopDraft => ({
  price: String(row.price),
  status: row.status,
  position: String(row.position),
});

export const checkShop = (draft: ShopDraft) =>
  checked(gemShopDocSchema, {
    price: wholeNumber(draft.price),
    status: draft.status,
    position: wholeNumber(draft.position),
  });

export const isShopDirty = (row: GemShopItemAdmin, draft: ShopDraft): boolean => {
  const stored = shopDraftOf(row);
  return (
    draft.price.trim() !== stored.price ||
    draft.status !== stored.status ||
    draft.position.trim() !== stored.position
  );
};
