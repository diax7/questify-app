import { toInstant, toLocalInput } from "@questify/shared";
import { FLASH_MAX_MINUTES } from "#src/lib/flash.ts";

export type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

/** A boost as the Boosts page reads it (`GET …/boosts`, T-307). */
export type Boost = Readonly<{
  id: string;
  categoryId: string;
  category: Bilingual;
  multiplier: number;
  startsAt: string;
  endsAt: string;
  /** For rehearsal accounts only, removed at go-live. */
  rehearsal: boolean;
  /** Edit and Delete stay open until a minute before the start, and never once it paid. */
  editable: boolean;
  paid: number;
}>;

export type BoostState = "scheduled" | "running" | "ended";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isText = (value: unknown): value is Bilingual =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

const isBoost = (value: unknown): value is Boost =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["categoryId"] === "string" &&
  isText(value["category"]) &&
  typeof value["multiplier"] === "number" &&
  typeof value["startsAt"] === "string" &&
  typeof value["endsAt"] === "string" &&
  typeof value["rehearsal"] === "boolean" &&
  typeof value["editable"] === "boolean" &&
  typeof value["paid"] === "number";

/** The boosts in the list's answer, or undefined when it is not that shape. */
export function boostsOf(body: unknown): readonly Boost[] | undefined {
  const list = isRecord(body) ? body["boosts"] : undefined;
  return Array.isArray(list) && list.every(isBoost) ? list : undefined;
}

/** Where a boost stands at `now`: not started, running, or ended (stopped included). */
export function boostStateOf(boost: Pick<Boost, "startsAt" | "endsAt">, now: number): BoostState {
  if (Date.parse(boost.startsAt) > now) {
    return "scheduled";
  }
  return Date.parse(boost.endsAt) > now ? "running" : "ended";
}

/** What the boost form holds: the category, Start now or a wall-clock start in the event's zone, and minutes. */
export type BoostDraft = Readonly<{
  id: string | null;
  categoryId: string;
  startNow: boolean;
  startsAt: string;
  minutes: number;
}>;

export const blankBoost = (categoryId: string): BoostDraft => ({
  id: null,
  categoryId,
  startNow: true,
  startsAt: "",
  minutes: 30,
});

/** A scheduled boost as the form edits it, its start in the event's zone. */
export function boostDraftOf(boost: Boost, timeZone: string): BoostDraft {
  return {
    id: boost.id,
    categoryId: boost.categoryId,
    startNow: false,
    startsAt: toLocalInput(new Date(boost.startsAt), timeZone),
    minutes: Math.round((Date.parse(boost.endsAt) - Date.parse(boost.startsAt)) / 60_000),
  };
}

/** The field this form would send wrong, checked here first; undefined when the draft is fine. */
export function boostProblem(draft: BoostDraft): "categoryId" | "startsAt" | "minutes" | undefined {
  if (draft.categoryId === "") {
    return "categoryId";
  }
  if (!draft.startNow && draft.startsAt === "") {
    return "startsAt";
  }
  return Number.isInteger(draft.minutes) && draft.minutes >= 1 && draft.minutes <= FLASH_MAX_MINUTES
    ? undefined
    : "minutes";
}

/** The body the API takes: the start as an instant read in the event's zone, or null for now. */
export function boostBodyOf(draft: BoostDraft, timeZone: string): Record<string, unknown> {
  return {
    categoryId: draft.categoryId,
    startsAt: draft.startNow ? null : toInstant(draft.startsAt, timeZone).toISOString(),
    minutes: draft.minutes,
  };
}
