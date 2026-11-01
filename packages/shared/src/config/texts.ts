import type { Language } from "#src/i18n/digits";
import { MESSAGES, type MessageKey, type Messages } from "#src/i18n/messages";
import { interpolate } from "#src/i18n/placeholders";
import {
  NO_OVERRIDES,
  isUsableOverride,
  validateTranslation,
  type Overrides,
  type PlaceholderRule,
} from "#src/i18n/translate";
import { cleanBlockText, isRecord, points } from "#src/layout/content-read";
import { DEFAULT_TERMS, wordParams } from "./terms";
import type { ConfigIssue, Validation } from "./validate";

/**
 * The labels an event may rename (FR-1843, T-614): the event bar's names, which the screens and the shop also use as their
 * titles. The currency word is the event's own word (`terms.currency`, the Event words form), not a second copy here. Legal,
 * consent and store-required texts are not on this list and are refused whatever the caller sends: a text is on it only by
 * being named here, in the same change that lets an event rename it.
 */
export const EVENT_TEXT_KEYS = [
  "nav.home",
  "nav.quests",
  "nav.scan",
  "nav.rewards",
  "nav.ranking",
  "nav.profile",
] as const satisfies readonly MessageKey[];

export type EventTextKey = (typeof EVENT_TEXT_KEYS)[number];

/** A bar label that is longer than this does not fit under its icon. */
export const EVENT_TEXT_MAX = 24;

/** The texts an event changed, per language and key: only usable values are present. Same shape as the translation store. */
export type EventTexts = Overrides;

export const NO_EVENT_TEXTS: EventTexts = NO_OVERRIDES;

/**
 * An event's text may leave out the placeholders the app fills with the event's own quest, category and player words
 * (renaming Quests to Adventures means the word is gone); any other placeholder, such as a count, must stay.
 */
const EVENT_TEXT_RULE: PlaceholderRule = {
  optional: new Set(Object.keys(wordParams(DEFAULT_TERMS, "en"))),
};

/** The shipped texts and the approved keys; a test passes its own to try a key that carries a count. */
export type TextCatalog = Readonly<{ messages: Messages; approved: readonly string[] }>;

const EVENT_TEXT_CATALOG: TextCatalog = { messages: MESSAGES, approved: EVENT_TEXT_KEYS };

const LANGUAGES = ["ar", "en"] as const satisfies readonly Language[];

// Control, line-break and bidi override or isolate characters would reorder or break a bar label.
// oxlint-disable-next-line no-control-regex -- the pattern exists to match control characters
const UNSAFE = new RegExp("[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]");

const emptyTexts = (): Record<Language, Record<string, string>> => ({ ar: {}, en: {} });

/** Cleans, bounds and checks one text; returns the text to store ("" when blank) or the issues. */
function checkText(
  catalog: TextCatalog,
  language: Language,
  key: string,
  raw: unknown,
): Validation<string> {
  const path = `${language}.${key}`;
  if (!catalog.approved.includes(key)) {
    return { ok: false, issues: [{ path, message: "is not a text an event can change" }] };
  }
  if (typeof raw !== "string") {
    return { ok: false, issues: [{ path, message: "must be text" }] };
  }
  const text = cleanBlockText(raw, false);
  if (text === "") {
    return { ok: true, value: "" };
  }
  if (points(text) > EVENT_TEXT_MAX) {
    return {
      ok: false,
      issues: [{ path, message: `must have at most ${EVENT_TEXT_MAX} characters` }],
    };
  }
  const checked = validateTranslation(catalog.messages, key, language, text, EVENT_TEXT_RULE);
  return checked.ok
    ? checked
    : { ok: false, issues: checked.issues.map((issue) => ({ ...issue, path })) };
}

type Texts = Record<string, string>;

/** One language's texts as saved: the texts to store (blanks left out) and every issue found. */
function checkLanguage(
  catalog: TextCatalog,
  language: Language,
  entries: unknown,
): Readonly<{ texts: Texts; issues: ConfigIssue[] }> {
  if (!isRecord(entries)) {
    return { texts: {}, issues: [{ path: language, message: "must be an object" }] };
  }
  const texts: Texts = {};
  const issues: ConfigIssue[] = [];
  for (const [key, raw] of Object.entries(entries)) {
    const checked = checkText(catalog, language, key, raw);
    if (!checked.ok) {
      issues.push(...checked.issues);
    } else if (checked.value !== "") {
      texts[key] = checked.value;
    }
  }
  return { texts, issues };
}

/** The same texts with the keys in the approved list's order, so equal texts store and compose as one document. */
function inOrder(texts: Texts, catalog: TextCatalog): Texts {
  const ordered: Texts = {};
  for (const key of catalog.approved) {
    const text = texts[key];
    if (text !== undefined) {
      ordered[key] = text;
    }
  }
  return ordered;
}

/**
 * Checks the texts an owner or editor saves, one set for the whole event: `{ar: {key: text}, en: {key: text}}`. A key that is
 * not on the approved list is refused. Each text is cleaned as the organizer's other words are (invisible and control
 * characters removed, Arabic-Indic digits written 0-9) and held to {@link EVENT_TEXT_MAX} characters. Placeholders that carry
 * a value must stay and no other may be added (the event's own word placeholders may go). A blank text is no change: it is
 * left out, so the platform text shows. The result is what to store and what the app receives.
 */
export function validateEventTexts(
  input: unknown,
  catalog: TextCatalog = EVENT_TEXT_CATALOG,
): Validation<EventTexts> {
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "body", message: "must be an object" }] };
  }
  const issues: ConfigIssue[] = Object.keys(input)
    .filter((name) => !LANGUAGES.some((language) => language === name))
    .map((name) => ({ path: name, message: "is not a language of the app" }));
  const texts = emptyTexts();
  for (const language of LANGUAGES) {
    const checked = checkLanguage(catalog, language, input[language] ?? {});
    issues.push(...checked.issues);
    texts[language] = inOrder(checked.texts, catalog);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: texts };
}

/** Whether a stored text can be shown as the label: within the length, no control or bidi override characters, and the right placeholders. */
function isUsableLabel(
  catalog: TextCatalog,
  language: Language,
  key: string,
  text: unknown,
): text is string {
  return (
    typeof text === "string" &&
    points(text) <= EVENT_TEXT_MAX &&
    !UNSAFE.test(text) &&
    isUsableOverride(catalog.messages, key, language, text, EVENT_TEXT_RULE)
  );
}

/**
 * Reads stored or received texts tolerantly: a text is kept only when its key is approved and it is usable (not blank,
 * within the length, no control or bidi override characters, the right placeholders), so a damaged value, an older
 * shape or a key a newer server added never leaves a hole in a label (FR-1768). Anything else shows the platform text.
 */
export function readEventTexts(
  stored: unknown,
  catalog: TextCatalog = EVENT_TEXT_CATALOG,
): EventTexts {
  const result = emptyTexts();
  if (!isRecord(stored)) {
    return result;
  }
  for (const language of LANGUAGES) {
    const entries = stored[language];
    if (isRecord(entries)) {
      for (const key of catalog.approved) {
        const text = entries[key];
        if (isUsableLabel(catalog, language, key, text)) {
          result[language][key] = text;
        }
      }
    }
  }
  return result;
}

/**
 * Puts an event's renamed labels over a translator: a label the event renamed shows its own text in that language, with the
 * placeholders filled from the call's values (the event's words included, when the label kept one); everything else is the
 * translator's own text. The texts are the ones `readEventTexts` kept, so this never shows a damaged value.
 */
export function withEventTexts<K extends string>(
  translate: (key: K, params?: Readonly<Record<string, string | number>>) => string,
  texts: EventTexts,
  language: Language,
): (key: K, params?: Readonly<Record<string, string | number>>) => string {
  return (key, params) => {
    const renamed = texts[language][key];
    return typeof renamed === "string"
      ? interpolate(renamed, params ?? {}, language)
      : translate(key, params);
  };
}
