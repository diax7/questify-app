import { z } from "zod";
import type { Language } from "#src/i18n/digits";
import type { Validation } from "./validate";

/** The five currency images an organizer picks from (FR-405); there is no upload. */
export const CURRENCY_ICONS = ["coin", "crownCoin", "gem", "leaf", "star"] as const;
export type CurrencyIcon = (typeof CURRENCY_ICONS)[number];

export const TERM_MAX = 30;

/** One word in one language: its singular and its plural. */
export type WordForms = Readonly<{ one: string; many: string }>;
export type Word = Readonly<Record<Language, WordForms>>;

/** The words an event renames (FR-404, FR-940), always complete: a word the event did not set is the default. */
export type EventTerms = Readonly<{
  currency: Word & Readonly<{ icon: CurrencyIcon }>;
  player: Word;
  operator: Word;
}>;

/** Questify's own words, used outside an event and for every word an event leaves unset. */
export const DEFAULT_TERMS: EventTerms = {
  currency: {
    icon: "coin",
    ar: { one: "نقطة", many: "نقاط" },
    en: { one: "point", many: "points" },
  },
  player: { ar: { one: "لاعب", many: "لاعبون" }, en: { one: "player", many: "players" } },
  operator: {
    ar: { one: "مشغّل", many: "مشغّلون" },
    en: { one: "operator", many: "operators" },
  },
};

// Digits of any script would clash with the number beside the word; control, line-break and bidi override or isolate
// characters would reorder or break the line; braces would read as a message placeholder.
const FORBIDDEN = /[\p{Nd}\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069{}]/u;

const form = z
  .string()
  .trim()
  .min(1, "must not be blank")
  .max(TERM_MAX, `must be at most ${TERM_MAX} characters`)
  .refine((value) => !FORBIDDEN.test(value), "must hold no digits, braces or control characters");
const forms = z.strictObject({ one: form, many: form });
const word = z.strictObject({ ar: forms, en: forms });
const icon = z.enum(CURRENCY_ICONS);

const currency = z
  .strictObject({ icon: icon.optional(), ar: forms.optional(), en: forms.optional() })
  .superRefine((value, context) => {
    if ((value.ar === undefined) !== (value.en === undefined)) {
      const missing = value.ar === undefined ? "ar" : "en";
      context.addIssue({
        code: "custom",
        path: [missing],
        message: "is required with the other language",
      });
    }
  });

const termsShape = z.strictObject({
  currency: currency.optional(),
  player: word.optional(),
  operator: word.optional(),
});

/** What an organizer saves: a word left out keeps the default, and the icon may be saved on its own. */
export type EventTermsInput = z.infer<typeof termsShape>;

/**
 * Checks the words an organizer saves. A word is named in both languages, each with both forms, or left out; every
 * form is trimmed and 1 to 30 characters, with no digits, braces, control or bidi override characters.
 */
export function validateEventTerms(input: unknown): Validation<EventTermsInput> {
  const parsed = termsShape.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Loose, unlike the save: a newer server may add keys (they are dropped), and only a wholly usable word is kept.
const looseForms = z.object({ one: form, many: form });
const looseWord = z.object({ ar: looseForms, en: looseForms });

const readWord = (value: unknown, fallback: Word): Word =>
  looseWord.safeParse(value).data ?? fallback;

/**
 * Reads stored or received words tolerantly: each word that is wholly usable is kept, and anything missing or damaged
 * is the default, so one bad value never empties a label (F-282).
 */
export function readEventTerms(value: unknown): EventTerms {
  const stored = isRecord(value) ? value : {};
  const storedCurrency = isRecord(stored["currency"]) ? stored["currency"] : {};
  const storedIcon = icon.safeParse(storedCurrency["icon"]);
  return {
    currency: {
      ...readWord(storedCurrency, DEFAULT_TERMS.currency),
      icon: storedIcon.success ? storedIcon.data : DEFAULT_TERMS.currency.icon,
    },
    player: readWord(stored["player"], DEFAULT_TERMS.player),
    operator: readWord(stored["operator"], DEFAULT_TERMS.operator),
  };
}

/**
 * The form of a word to show. Arabic never counts a renamed noun (ADR-058: it is a label, «نقاط: 1»), so it is always
 * the plural. In English, beside a count it is the singular for exactly 1 and the plural otherwise, as typed ("+1 gem");
 * with no count it is a label or heading, the plural with a capital ("Gems: 120").
 */
export function termFor(term: Word, language: Language, count?: number): string {
  if (language === "ar") {
    return term.ar.many;
  }
  if (count === undefined) {
    return term.en.many.charAt(0).toUpperCase() + term.en.many.slice(1);
  }
  return count === 1 ? term.en.one : term.en.many;
}
