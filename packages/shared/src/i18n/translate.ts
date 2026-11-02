import type { ConfigIssue, Validation } from "#src/config/validate";
import { toWesternDigits, type Language } from "./digits";
import type { Messages } from "./messages";
import { interpolate, placeholdersOf } from "./placeholders";

/** The values the translation store holds, per language and key. Only keys an admin has set are present. */
export type Overrides = Readonly<Record<Language, Readonly<Record<string, string>>>>;

export const NO_OVERRIDES: Overrides = { ar: {}, en: {} };

const MAX_TEXT_LENGTH = 1000;

/**
 * Which placeholders of a shipped text a change may leave out. Every other placeholder must stay, and no other may be
 * added. The admin store keeps all of them; an event may drop the names the app fills with the event's own words (T-614).
 */
export type PlaceholderRule = Readonly<{ optional: ReadonlySet<string> }>;

const KEEP_ALL_PLACEHOLDERS: PlaceholderRule = { optional: new Set() };

/** The placeholders `text` lacks (`missing`) or adds (`extra`) against the shipped text, under the rule. */
function placeholderGaps(
  shipped: string,
  text: string,
  rule: PlaceholderRule,
): Readonly<{ missing: string[]; extra: string[] }> {
  const expected = placeholdersOf(shipped);
  const found = placeholdersOf(text);
  return {
    missing: expected.filter((name) => !found.includes(name) && !rule.optional.has(name)),
    extra: found.filter((name) => !expected.includes(name)),
  };
}

function placeholderIssues(
  shipped: string,
  text: string,
  language: Language,
  rule: PlaceholderRule,
): ConfigIssue[] {
  const { missing, extra } = placeholderGaps(shipped, text, rule);
  return [
    ...missing.map((name) => ({ path: language, message: `is missing {${name}}` })),
    ...extra.map((name) => ({
      path: language,
      message: `uses {${name}}, which this text does not have`,
    })),
  ];
}

/** True when a stored value may replace the shipped text: not blank, and the placeholders of the default (under the rule). */
export function isUsableOverride(
  messages: Messages,
  key: string,
  language: Language,
  text: string,
  rule: PlaceholderRule = KEEP_ALL_PLACEHOLDERS,
): boolean {
  const shipped = messages[key]?.[language];
  if (shipped === undefined || text.trim() === "") {
    return false;
  }
  const { missing, extra } = placeholderGaps(shipped, text, rule);
  return missing.length === 0 && extra.length === 0;
}

/**
 * Checks a text an admin wants to save for one key and one language.
 * - A blank value is accepted and means "remove my change, use the shipped text" (FR-1766).
 * - Otherwise every placeholder of the shipped text must still be there, with no other placeholder (FR-1767).
 * - Arabic-Indic digits become 0-9 (FR-1507); the returned value is the one to store.
 */
export function validateTranslation(
  messages: Messages,
  key: string,
  language: Language,
  text: string,
  rule: PlaceholderRule = KEEP_ALL_PLACEHOLDERS,
): Validation<string> {
  const shipped = messages[key]?.[language];
  if (shipped === undefined) {
    return { ok: false, issues: [{ path: "key", message: "is not a text of the app" }] };
  }
  const value = toWesternDigits(text.trim());
  if (value === "") {
    return { ok: true, value: "" };
  }
  const issues: ConfigIssue[] = [];
  if (value.length > MAX_TEXT_LENGTH) {
    issues.push({ path: language, message: `must have at most ${MAX_TEXT_LENGTH} characters` });
  }
  issues.push(...placeholderIssues(shipped, value, language, rule));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/**
 * Makes the function the app calls to show a text. The text is the admin's value when there is a usable one and
 * the shipped text otherwise, so a blank, missing, unreachable or damaged value can never leave a hole (FR-1768).
 */
export function createTranslator<M extends Messages>(
  messages: M,
  overrides: Overrides = NO_OVERRIDES,
): (
  key: keyof M & string,
  language: Language,
  params?: Readonly<Record<string, string | number>>,
) => string {
  return (key, language, params = {}) => {
    const stored = overrides[language][key];
    const shipped = messages[key]?.[language] ?? key;
    const text =
      stored !== undefined && isUsableOverride(messages, key, language, stored) ? stored : shipped;
    return interpolate(text, params, language);
  };
}

/**
 * Reads the translation store's answer (`GET /v1/translations`) tolerantly: only plain-text values under an object per
 * language are kept; anything else is dropped. Whether a kept value is usable is decided when it is shown
 * (`createTranslator`), so a damaged answer never leaves a hole.
 */
export function readOverrides(body: unknown): Overrides {
  if (typeof body !== "object" || body === null) {
    return NO_OVERRIDES;
  }
  const result: Record<Language, Record<string, string>> = { ar: {}, en: {} };
  for (const language of ["ar", "en"] as const) {
    const texts = (body as Record<string, unknown>)[language];
    if (typeof texts !== "object" || texts === null) {
      continue;
    }
    for (const [key, text] of Object.entries(texts)) {
      if (typeof text === "string") {
        result[language][key] = text;
      }
    }
  }
  return result;
}
