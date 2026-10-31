import type { ChangeSetApplied, ChangeSetItem, MessageKey } from "@questify/shared";
import type { Translate } from "#src/lib/language.ts";

type Target = ChangeSetItem["target"];

/**
 * The words for each field of an item's before and after, by target (the fields are the change log's own). A field
 * with no entry shows its own name.
 */
export const FIELD_LABELS: Readonly<Record<Target, Readonly<Record<string, MessageKey>>>> = {
  quest: {
    categoryId: "quests.field.category",
    type: "quests.field.type",
    titleAr: "quests.field.titleAr",
    titleEn: "quests.field.titleEn",
    descriptionAr: "quests.field.descriptionAr",
    descriptionEn: "quests.field.descriptionEn",
    points: "quests.field.points",
    repeatCap: "quests.field.repeatCap",
    opensAt: "quests.field.opensAt",
    closesAt: "quests.field.closesAt",
    visible: "quests.field.visible",
    config: "changeSets.field.config",
    verification: "changeSets.field.verification",
    itemId: "changeSets.field.itemId",
    place: "quests.place.title",
    flash: "changeSets.field.flash",
    steps: "quests.passport.steps",
  },
  category: {
    nameAr: "quests.field.categoryAr",
    nameEn: "quests.field.categoryEn",
    orderMode: "quests.field.orderMode",
    opensAt: "quests.field.categoryOpensAt",
    unlockAfter: "quests.field.unlockAfter",
    completionBonus: "quests.field.completionBonus",
    refresh: "quests.field.refresh",
    hidden: "quests.field.hidden",
    itemId: "changeSets.field.itemId",
  },
  reward: {
    kind: "rewards.kind",
    name: "changeSets.field.name",
    description: "changeSets.field.description",
    price: "rewards.price",
    stock: "rewards.stock",
    perPlayerLimit: "rewards.perPlayerLimit",
    opensAt: "rewards.opensAt",
    closesAt: "rewards.closesAt",
    section: "rewards.section",
    tags: "changeSets.field.tags",
  },
};

export const fieldLabel = (target: Target, field: string, t: Translate): string => {
  const key = FIELD_LABELS[target][field];
  return key === undefined ? field : t(key);
};

const isBilingual = (value: unknown): value is { ar?: unknown; en?: unknown } =>
  typeof value === "object" && value !== null && ("ar" in value || "en" in value);

/** A value of the change log as a short line: text and numbers as they are, a bilingual pair joined, a switch in words. */
export function valueText(value: unknown, t: Translate): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "boolean") {
    return t(value ? "changeSets.yes" : "changeSets.no");
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (isBilingual(value)) {
    return [value.ar, value.en].filter((one) => typeof one === "string" && one !== "").join(" / ");
  }
  return JSON.stringify(value);
}

/** An item the reviewer can select: only one that is ready now. */
export const selectable = (item: ChangeSetItem): boolean => item.state === "ready";

/** The ids that can still be selected, in the page's order. */
export const readyIds = (items: readonly ChangeSetItem[]): string[] =>
  items.filter(selectable).map((item) => item.id);

/** How many of an apply's results ended each way, for the line under the page. */
export function tally(results: ChangeSetApplied["results"]): {
  applied: number;
  failed: number;
  stale: number;
} {
  const count = (status: ChangeSetApplied["results"][number]["status"]) =>
    results.filter((one) => one.status === status).length;
  return { applied: count("applied"), failed: count("failed"), stale: count("stale") };
}
