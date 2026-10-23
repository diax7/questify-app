import {
  PASSPORT_STEPS_MAX,
  PLACED_QUEST_TYPES,
  PLACE_RADIUS,
  parseQuestConfig,
  parseVerification,
  toLocalInput,
  type Language,
  type MessageKey,
  type QuestType,
  type QuestVerification,
} from "@questify/shared";
import { isRadius, pinIsValid, pinTyped } from "#src/lib/coordinates.ts";
import { itemChoice } from "#src/lib/quest-items.ts";

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
  verification: readonly QuestVerification[];
  /** A passport's steps in order (T-304b); absent for other types. */
  steps?: readonly Readonly<{ id: string; name: Bilingual; position: number }>[];
  /** The quest item its first completion gives (T-304d), or null. */
  itemId: string | null;
  /** Its place on a spot type (T-303b): a pin and a radius in metres; required for a location quest. */
  place: Readonly<{ lat: number; lng: number; radiusM: number }> | null;
}>;

/** A passport step as the form holds it (`PassportFields`): `saved` marks one the API already has. */
type FormStep = Readonly<{
  id: string;
  text: Readonly<{ ar?: string; en?: string }>;
  saved?: boolean;
}>;

/** A passport's steps from the API, as the form holds them inside its config. */
const formSteps = (quest: QuestView): FormStep[] =>
  (quest.steps ?? []).map((step) => ({
    id: step.id,
    saved: true,
    text: {
      ...(step.name.ar === null ? {} : { ar: step.name.ar }),
      ...(step.name.en === null ? {} : { en: step.name.en }),
    },
  }));

type ApiParts = Readonly<{
  config: Readonly<Record<string, unknown>>;
  steps?: readonly Readonly<{ id?: string; name: Readonly<{ ar: string; en: string }> }>[];
}>;

/**
 * What the API takes of a draft's config: a passport's steps live in its form config, but the API takes them beside it
 * (`steps`: a saved step by its id, a new one without).
 */
function apiParts(draft: QuestDraft): ApiParts {
  if (draft.type !== "passport") {
    return { config: draft.config };
  }
  const { steps, ...config } = draft.config;
  const list = Array.isArray(steps) ? (steps as FormStep[]) : [];
  return {
    config,
    steps: list.map((step) => ({
      ...(step.saved === true ? { id: step.id } : {}),
      name: { ar: step.text.ar ?? "", en: step.text.en ?? "" },
    })),
  };
}

export type CategoryView = Readonly<{
  id: string;
  name: Bilingual;
  position: number;
  /** A category's rules (T-304, FR-231 to FR-235). */
  orderMode: "any" | "in_order";
  opensAt: string | null;
  unlockAfter: string | null;
  completionBonus: number;
  /** How often its quests start again, and whether it stays hidden until found (T-304c, FR-236, FR-237). */
  refresh: "none" | "daily" | "weekly";
  hidden: boolean;
  /** The quest item its bonus gives, once per period (T-304d), or null. */
  itemId: string | null;
  quests: readonly QuestView[];
}>;

/** What the category form sends: the names and the rules, each field read from the form (T-304, T-304c). */
export function categoryBody(form: FormData): Record<string, unknown> {
  const text = (key: string) => String(form.get(key) ?? "");
  const blankToNull = (key: string) => (text(key) === "" ? null : text(key));
  return {
    name: { ar: text("ar"), en: text("en") },
    orderMode: text("orderMode") === "in_order" ? "in_order" : "any",
    opensAt: blankToNull("opensAt"),
    unlockAfter: blankToNull("unlockAfter"),
    completionBonus: Number(text("completionBonus") || "0"),
    refresh: text("refresh") === "daily" || text("refresh") === "weekly" ? text("refresh") : "none",
    hidden: form.get("hidden") === "on",
    itemId: blankToNull("itemId"),
  };
}

/** A category's rules as short notes for the builder's card, in the order the card shows them. */
export type CategoryRuleNote =
  | Readonly<{ kind: "inOrder" }>
  | Readonly<{ kind: "opens"; at: string }>
  | Readonly<{ kind: "unlockAfter"; name: Bilingual }>
  | Readonly<{ kind: "bonus"; points: number }>
  | Readonly<{ kind: "resets"; refresh: "daily" | "weekly" }>
  | Readonly<{ kind: "hidden" }>;

export function categoryRuleNotes(
  category: CategoryView,
  categories: readonly CategoryView[],
): CategoryRuleNote[] {
  const notes: CategoryRuleNote[] = [];
  if (category.orderMode === "in_order") {
    notes.push({ kind: "inOrder" });
  }
  if (category.opensAt !== null) {
    notes.push({ kind: "opens", at: category.opensAt });
  }
  const first = categories.find((other) => other.id === category.unlockAfter);
  if (first !== undefined) {
    notes.push({ kind: "unlockAfter", name: first.name });
  }
  if (category.completionBonus > 0) {
    notes.push({ kind: "bonus", points: category.completionBonus });
  }
  if (category.refresh !== "none") {
    notes.push({ kind: "resets", refresh: category.refresh });
  }
  if (category.hidden) {
    notes.push({ kind: "hidden" });
  }
  return notes;
}

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
  /** How it is verified (FR-301); a type that offers no method has none. */
  verification: readonly QuestVerification[];
  /** The quest item it gives (T-304d); empty for none. */
  itemId: string;
  /** The place as typed (T-303b); both pin numbers empty means no place. The radius starts at its default. */
  placeLat: string;
  placeLng: string;
  placeRadius: string;
}>;

/** The radius a new place starts with, in metres: a doorway-sized circle. */
export const DEFAULT_PLACE_RADIUS = 100;

/** Whether this type may carry a place (the spot types, T-303b). */
export const hasPlace = (type: QuestType): boolean => PLACED_QUEST_TYPES.includes(type);

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
    verification: ["quest_qr"],
    itemId: "",
    placeLat: "",
    placeLng: "",
    placeRadius: String(DEFAULT_PLACE_RADIUS),
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
    config: quest.type === "passport" ? { ...quest.config, steps: formSteps(quest) } : quest.config,
    verification: quest.verification,
    itemId: quest.itemId ?? "",
    placeLat: quest.place === null ? "" : String(quest.place.lat),
    placeLng: quest.place === null ? "" : String(quest.place.lng),
    placeRadius: String(quest.place?.radiusM ?? DEFAULT_PLACE_RADIUS),
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
  ...apiParts(draft),
  verification: draft.verification,
  itemId: itemChoice(draft.itemId),
  ...(hasPlace(draft.type) ? { place: placeOf(draft) } : {}),
});

/** The place the draft holds: null when no pin is typed (a place is a pin and a radius together). */
function placeOf(draft: QuestDraft): QuestView["place"] {
  return pinTyped(draft.placeLat, draft.placeLng)
    ? {
        lat: Number(draft.placeLat),
        lng: Number(draft.placeLng),
        radiusM: Number(draft.placeRadius),
      }
    : null;
}

/** Whether the place is what the API takes: a whole pin in range and 20 to 2000 m, or none (not for a location). */
function placeIsValid(draft: QuestDraft): boolean {
  if (!hasPlace(draft.type)) {
    return true;
  }
  if (!pinTyped(draft.placeLat, draft.placeLng)) {
    return draft.type !== "location";
  }
  return (
    pinIsValid(draft.placeLat, draft.placeLng) &&
    isRadius(draft.placeRadius, PLACE_RADIUS.min, PLACE_RADIUS.max)
  );
}

/** The words for a builder field the API or this form refused: the place has its own, the rest are `quests.invalid.*`. */
export function invalidQuestKey(field: string): MessageKey {
  return field === "place" ? "quests.place.invalid" : (`quests.invalid.${field}` as MessageKey);
}

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
):
  | "title"
  | "points"
  | "closesAt"
  | "config"
  | "verification"
  | "steps"
  | "needed"
  | "place"
  | "dailyCap"
  | undefined {
  if (draft.titleAr.trim() === "" && draft.titleEn.trim() === "") {
    return "title";
  }
  if (!Number.isInteger(draft.points) || draft.points < 0 || draft.points > 100_000) {
    return "points";
  }
  if (draft.opensAt !== "" && draft.closesAt !== "" && draft.closesAt <= draft.opensAt) {
    return "closesAt";
  }
  if (!placeIsValid(draft)) {
    return "place";
  }
  const parts = apiParts(draft);
  const steps = parts.steps;
  if (steps !== undefined) {
    const named = steps.every((step) => step.name.ar.trim() !== "" || step.name.en.trim() !== "");
    if (steps.length === 0 || steps.length > PASSPORT_STEPS_MAX || !named) {
      return "steps";
    }
    if (Number(parts.config["needed"]) > steps.length) {
      return "needed";
    }
  }
  if (parseQuestConfig(draft.type, parts.config) === undefined) {
    return draft.type === "meet" ? "dailyCap" : "config";
  }
  // A meet quest's day can never pay more meetings than its whole life (ADR-210).
  if (draft.type === "meet" && Number(parts.config["dailyCap"]) > draft.repeatCap) {
    return "dailyCap";
  }
  return parseVerification(draft.type, draft.verification) === undefined
    ? "verification"
    : undefined;
}
