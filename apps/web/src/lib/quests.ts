import { parseQuestConfig, toLocalInput, type Language, type QuestType } from "@questify/shared";

type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

/** A quest as the builder API answers it (apps/api/src/quests/routes.ts). */
export type QuestView = Readonly<{
  id: string;
  categoryId: string;
  type: QuestType;
  title: Bilingual;
  description: Bilingual;
  points: number;
  repeatCap: number;
  opensAt: string | null;
  closesAt: string | null;
  visible: boolean;
  position: number;
  config: Readonly<Record<string, unknown>>;
}>;

export type CategoryView = Readonly<{
  id: string;
  name: Bilingual;
  position: number;
  quests: readonly QuestView[];
}>;

/** Organizer text in the page's language, else the other one (FR-1008: one is enough). */
export function textFor(text: Bilingual, language: Language): string {
  const other = language === "ar" ? text.en : text.ar;
  return text[language] ?? other ?? "";
}

/** The ids in a new order: the one at `index` swapped with its neighbour `by` places away (-1 up, +1 down). */
export function moved(ids: readonly string[], index: number, by: -1 | 1): string[] | undefined {
  const target = index + by;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) {
    return undefined;
  }
  const next = [...ids];
  [next[index], next[target]] = [next[target] as string, next[index] as string];
  return next;
}

/** What the quest form holds: times as the wall clock in the event's zone, empty when not set. */
export type QuestDraft = Readonly<{
  type: QuestType;
  categoryId: string;
  titleAr: string;
  titleEn: string;
  descriptionAr: string;
  descriptionEn: string;
  points: number;
  repeatCap: number;
  opensAt: string;
  closesAt: string;
  visible: boolean;
  config: Readonly<Record<string, unknown>>;
}>;

export function blankQuest(categoryId: string): QuestDraft {
  return {
    type: "scan_qr",
    categoryId,
    titleAr: "",
    titleEn: "",
    descriptionAr: "",
    descriptionEn: "",
    points: 10,
    repeatCap: 1,
    opensAt: "",
    closesAt: "",
    visible: true,
    config: {},
  };
}

export function questDraftOf(quest: QuestView, timeZone: string): QuestDraft {
  const local = (iso: string | null) => (iso === null ? "" : toLocalInput(new Date(iso), timeZone));
  return {
    type: quest.type,
    categoryId: quest.categoryId,
    titleAr: quest.title.ar ?? "",
    titleEn: quest.title.en ?? "",
    descriptionAr: quest.description.ar ?? "",
    descriptionEn: quest.description.en ?? "",
    points: quest.points,
    repeatCap: quest.repeatCap,
    opensAt: local(quest.opensAt),
    closesAt: local(quest.closesAt),
    visible: quest.visible,
    config: quest.config,
  };
}

const fieldsOf = (draft: QuestDraft): Record<string, unknown> => ({
  categoryId: draft.categoryId,
  title: { ar: draft.titleAr, en: draft.titleEn },
  description: { ar: draft.descriptionAr, en: draft.descriptionEn },
  points: draft.points,
  repeatCap: draft.repeatCap,
  opensAt: draft.opensAt === "" ? null : draft.opensAt,
  closesAt: draft.closesAt === "" ? null : draft.closesAt,
  visible: draft.visible,
  config: draft.config,
});

/** The body to create a quest: everything, with its type. */
export function createQuestBody(draft: QuestDraft): Record<string, unknown> {
  return { type: draft.type, ...fieldsOf(draft) };
}

/** The body to edit a quest: only what changed (the type never changes). */
export function editQuestBody(draft: QuestDraft, before: QuestDraft): Record<string, unknown> {
  const now = fieldsOf(draft);
  const then = fieldsOf(before);
  return Object.fromEntries(
    Object.entries(now).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(then[key]),
    ),
  );
}

/**
 * The first field the API would refuse, checked here first with the same shared rules, so a live event's confirmation
 * is never asked for a change that would fail anyway. Undefined when the draft is fine.
 */
export function questProblem(
  draft: QuestDraft,
): "title" | "points" | "closesAt" | "config" | undefined {
  if (draft.titleAr.trim() === "" && draft.titleEn.trim() === "") {
    return "title";
  }
  if (!Number.isInteger(draft.points) || draft.points < 0 || draft.points > 100_000) {
    return "points";
  }
  if (draft.opensAt !== "" && draft.closesAt !== "" && draft.closesAt <= draft.opensAt) {
    return "closesAt";
  }
  return parseQuestConfig(draft.type, draft.config) === undefined ? "config" : undefined;
}
