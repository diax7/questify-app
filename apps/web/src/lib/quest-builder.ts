import { readEventTerms, type EventTerms, type Language } from "@questify/shared";
import type { Translate } from "#src/lib/language.ts";
import { invalidQuestKey } from "#src/lib/quests.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";

export type BuilderEvent = Readonly<{
  timezone: string;
  name: string;
  statusNow: string;
  terms: EventTerms;
  /** The event's flash quests and double points switches (T-307); on when the API does not say. */
  flashQuests: boolean;
  boosts: boolean;
}>;

const FIELD_CODES = new Set(["invalid_quest", "invalid_category"]);

/** The words for a refusal: the field to fix for a builder 422, the API's own message otherwise. */
export function problemText(body: unknown, language: Language, t: Translate): string {
  const field = (body as { details?: { field?: unknown } } | undefined)?.details?.field;
  const code = errorCodeOf(body);
  if (code !== undefined && FIELD_CODES.has(code) && typeof field === "string") {
    return t(invalidQuestKey(field));
  }
  return describeProblem(body, language, t).text;
}

/** The event's header as `GET …/events/{id}` answers it, in the language asked for (its other name when one is unset). */
export function builderEventOf(body: unknown, language: Language): BuilderEvent {
  const view = (
    body as {
      event: {
        timezone: string;
        statusNow: string;
        name: { ar: string | null; en: string | null };
        terms?: unknown;
        flashQuests?: boolean;
        boosts?: boolean;
      };
    }
  ).event;
  const other = language === "ar" ? view.name.en : view.name.ar;
  return {
    timezone: view.timezone,
    statusNow: view.statusNow,
    name: view.name[language] ?? other ?? "",
    terms: readEventTerms(view.terms),
    flashQuests: view.flashQuests !== false,
    boosts: view.boosts !== false,
  };
}

/** The headers of a builder request: the Idempotency-Key of a create, none for any other call. */
export function sendHeaders(key: string | undefined): Record<string, string> {
  return key === undefined ? {} : { "idempotency-key": key };
}
