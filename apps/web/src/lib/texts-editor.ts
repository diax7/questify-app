import {
  EVENT_TEXT_KEYS,
  validateEventTexts,
  type EventTextKey,
  type EventTexts,
  type Language,
} from "@questify/shared";

export const TEXT_LANGUAGES = ["ar", "en"] as const satisfies readonly Language[];

/** What the page holds while the owner types: every approved label in both languages, "" for one left to the platform. */
export type TextsDraft = Readonly<Record<Language, Readonly<Record<EventTextKey, string>>>>;

const blankRow = (): Record<EventTextKey, string> =>
  Object.fromEntries(EVENT_TEXT_KEYS.map((key) => [key, ""])) as Record<EventTextKey, string>;

/** The draft for the texts the event holds, with a blank for every label it did not rename. */
export function draftOf(texts: EventTexts): TextsDraft {
  const draft = { ar: blankRow(), en: blankRow() };
  for (const language of TEXT_LANGUAGES) {
    for (const key of EVENT_TEXT_KEYS) {
      draft[language][key] = texts[language][key] ?? "";
    }
  }
  return draft;
}

/** The body to save: the labels with something typed, trimmed; a blank is left out and returns to the platform's text. */
export function bodyOf(draft: TextsDraft): Record<Language, Record<string, string>> {
  const body: Record<Language, Record<string, string>> = { ar: {}, en: {} };
  for (const language of TEXT_LANGUAGES) {
    for (const key of EVENT_TEXT_KEYS) {
      const text = draft[language][key].trim();
      if (text !== "") {
        body[language][key] = text;
      }
    }
  }
  return body;
}

export function withText(
  draft: TextsDraft,
  language: Language,
  key: EventTextKey,
  text: string,
): TextsDraft {
  return { ...draft, [language]: { ...draft[language], [key]: text } };
}

/** One label back to the platform's text in both languages. */
export function resetLabel(draft: TextsDraft, key: EventTextKey): TextsDraft {
  return withText(withText(draft, "ar", key, ""), "en", key, "");
}

/** Whether the event renamed this label in either language. */
export const isRenamed = (draft: TextsDraft, key: EventTextKey): boolean =>
  TEXT_LANGUAGES.some((language) => draft[language][key].trim() !== "");

/** Whether the draft saves anything different from what the event holds. */
export function differs(a: TextsDraft, b: TextsDraft): boolean {
  return JSON.stringify(bodyOf(a)) !== JSON.stringify(bodyOf(b));
}

/** The first label the server's own check would refuse (a bracketed name the label does not have), or null. */
export function problemOf(
  draft: TextsDraft,
): Readonly<{ key: EventTextKey; language: Language }> | null {
  const checked = validateEventTexts(bodyOf(draft));
  if (checked.ok) {
    return null;
  }
  const [language, ...rest] = (checked.issues[0]?.path ?? "").split(".");
  const key = EVENT_TEXT_KEYS.find((candidate) => candidate === rest.join("."));
  return key !== undefined && (language === "ar" || language === "en") ? { key, language } : null;
}
