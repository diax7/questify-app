import type { ConfigIssue, Validation } from "#src/config/validate";
import { toWesternDigits, type Language } from "./digits";
import type { Messages } from "./messages";
import { interpolate, placeholdersOf } from "./placeholders";

/** The values the translation store holds, per language and key. Only keys an admin has set are present. */
export type Overrides = Readonly<Record<Language, Readonly<Record<string, string>>>>;

export const NO_OVERRIDES: Overrides = { ar: {}, en: {} };

const MAX_TEXT_LENGTH = 1000;

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((name, index) => name === b[index]);

/** True when a stored value may replace the shipped text: not blank, and the same placeholders as the default. */
export function isUsableOverride(
  messages: Messages,
  key: string,
  language: Language,
  text: string,
): boolean {
  const shipped = messages[key]?.[language];
  return (
    shipped !== undefined &&
    text.trim() !== "" &&
    sameSet(placeholdersOf(text), placeholdersOf(shipped))
  );
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
  const expected = placeholdersOf(shipped);
  const found = placeholdersOf(value);
  for (const missing of expected.filter((placeholder) => !found.includes(placeholder))) {
    issues.push({ path: language, message: `is missing {${missing}}` });
  }
  for (const extra of found.filter((placeholder) => !expected.includes(placeholder))) {
    issues.push({ path: language, message: `uses {${extra}}, which this text does not have` });
  }
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
