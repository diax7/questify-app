import type { Language } from "@questify/shared";
import type { EventDraft, EventView } from "#src/lib/events.ts";
import { timesChanged } from "#src/lib/events.ts";
import type { Translate } from "#src/lib/language.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);
const FIELDS = new Set([
  "name",
  "timezone",
  "startsAt",
  "endsAt",
  "joinMethods",
  "cityId",
  "interests",
  "template",
]);

/** Whether the API's refusal says the sign-in has ended, so the page goes to the sign-in screen. */
export function sessionEnded(body: unknown): boolean {
  const code = errorCodeOf(body);
  return code !== undefined && SESSION_LOST.has(code);
}

/** The words for a refusal: the field to fix for `invalid_event`, the API's own message otherwise. */
export function problemText(body: unknown, language: Language, t: Translate): string {
  const details = (body as { details?: { field?: unknown } } | undefined)?.details;
  const field = details?.field;
  if (errorCodeOf(body) === "invalid_event" && typeof field === "string" && FIELDS.has(field)) {
    return t(`events.invalid.${field}` as "events.invalid.name");
  }
  return describeProblem(body, language, t).text;
}

export type SaveQuestion = "access" | "dates";

/** What a save of an existing event must confirm first: a changed access type, else changed times or zone. */
export function saveQuestion(draft: EventDraft, event: EventView): SaveQuestion | null {
  if (draft.access !== event.access) {
    return "access";
  }
  return timesChanged(draft, event) ? "dates" : null;
}

/** Whether the access question's answer leads to the times question: the access change also moves the times. */
export const asksDatesNext = (
  asking: SaveQuestion | null,
  draft: EventDraft | null,
  event: EventView | null,
): boolean => draft !== null && event !== null && asking === "access" && timesChanged(draft, event);
