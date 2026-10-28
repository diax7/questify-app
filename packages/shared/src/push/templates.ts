import { readEventTerms, wordParams } from "#src/config/terms";
import { toWesternDigits, type Language } from "#src/i18n/digits";
import { MESSAGES, type Messages } from "#src/i18n/messages";
import { interpolate, placeholdersOf } from "#src/i18n/placeholders";
import { invitationNameIssue, trimName } from "#src/invitation-campaigns/name-rule";

/**
 * Push and center text (T-501, ADR-346): one fixed template per kind, the same for the push and the center row. A
 * template names only the public names an organizer wrote (frozen on the notice in both languages) and a date or a
 * time in the event's zone, besides the event's own words for quests, categories and players. Never a person, an
 * amount, a rank, an answer, a ticket, a submission or a reason: the text goes through Apple and Google.
 */

/** Organizer-written public names a template may name, each frozen on the notice as `{ar, en}`. */
export const PUSH_NAME_PLACEHOLDERS = ["event", "quest", "category", "reward"] as const;
/** A moment frozen on the notice as an ISO instant, shown in the event's zone. */
export const PUSH_TIME_PLACEHOLDERS = ["date", "time"] as const;
/** The event's words for quests, categories and players (FR-941): every form `wordParams` gives. */
export const PUSH_TERM_PLACEHOLDERS: readonly string[] = ["quest", "category", "player"].flatMap(
  (word) => [`${word}One`, `${word}Many`, `${word}OneCap`, `${word}Cap`],
);
/** Every placeholder a push template may hold (a unit test enumerates every template against it). */
export const PUSH_PLACEHOLDERS: readonly string[] = [
  ...PUSH_NAME_PLACEHOLDERS,
  ...PUSH_TIME_PLACEHOLDERS,
  ...PUSH_TERM_PLACEHOLDERS,
];

/**
 * One kind's text: the body with its names, and the nameless body sent when a name it uses is missing or fails the
 * name rule. Both are `messages.ts` keys; the title is the event's name when it passes the rule, else "Questify".
 */
export type PushTemplate = Readonly<{ body: string; nameless: string }>;

/** A kind whose text names nothing: its body (`push.<key>.body`, the kind in camel case) is its nameless variant. */
const fixedTemplate = (key: string): PushTemplate => ({
  body: `push.${key}.body`,
  nameless: `push.${key}.body`,
});
/** A kind whose text names something: `push.<key>.body`, else `push.<key>.nameless`. */
const namedTemplate = (key: string): PushTemplate => ({
  body: `push.${key}.body`,
  nameless: `push.${key}.nameless`,
});

/**
 * Every kind that is pushed, by `notice_kind.kind`. Each wiring slice (T-501d onward) adds its kinds here with their
 * `notice_kind` rows; a database test checks that every kind row has an entry. A kind with none shows the generic text
 * in the center and is never pushed.
 */
export const PUSH_TEMPLATES: Readonly<Record<string, PushTemplate>> = {
  // T-501d (migration 0077): the personal pushes.
  join_accepted: fixedTemplate("joinAccepted"),
  join_declined: fixedTemplate("joinDeclined"),
  help_answered: fixedTemplate("helpAnswered"),
  help_answered_questify: fixedTemplate("helpAnsweredQuestify"),
  help_solved: fixedTemplate("helpSolved"),
  rank_prize: namedTemplate("rankPrize"),
  submission_approved: namedTemplate("submissionApproved"),
  submission_rejected: namedTemplate("submissionRejected"),
  reward_ready: namedTemplate("rewardReady"),
  reward_ending: namedTemplate("rewardEnding"),
};

/** What the renderer reads from a claimed send or a center row. */
export type NoticeContent = Readonly<{
  kind: string;
  /** The notice's frozen names (`{ar, en}` each) and moments (ISO instants), as stored. */
  params: unknown;
  /** The event's stored words (`event.config.terms`), or null without an event. */
  terms: unknown;
  /** The event's IANA zone, or null without an event. */
  timezone: string | null;
  language: Language;
}>;

export type RenderedNotice = Readonly<{
  title: string;
  body: string;
  /** False for a kind without a template: the center shows the generic text and nothing is pushed. */
  pushable: boolean;
}>;

export type PushTexts = Readonly<{
  templates: Readonly<Record<string, PushTemplate>>;
  messages: Messages;
}>;

const SHIPPED: PushTexts = { templates: PUSH_TEMPLATES, messages: MESSAGES };
const FALLBACK_ZONE = "Asia/Riyadh";
const LOCALES: Readonly<Record<Language, string>> = { ar: "ar-u-ca-gregory-nu-latn", en: "en-GB" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A frozen name in the language asked for, else the other one, cut to 40 units; null when there is none or it fails
 * the name rule (an address, a phone number, invisible characters), so the template's nameless variant is used.
 */
export function pushName(value: unknown, language: Language): string | null {
  if (!isRecord(value)) return null;
  const read = (lang: Language): string => {
    const text = value[lang];
    return typeof text === "string" ? text.trim() : "";
  };
  const chosen = read(language) === "" ? read(language === "ar" ? "en" : "ar") : read(language);
  if (chosen === "" || invitationNameIssue(chosen) !== null) return null;
  return trimName(chosen);
}

/** A frozen moment as a date ("23 Oct") or a 24-hour time ("16:00") in the zone, Western digits; null if unreadable. */
export function pushMoment(
  value: unknown,
  form: "date" | "time",
  timeZone: string | null,
  language: Language,
): string | null {
  if (typeof value !== "string") return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const options: Intl.DateTimeFormatOptions =
    form === "date"
      ? { day: "numeric", month: "short" }
      : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  try {
    const zone = timeZone ?? FALLBACK_ZONE;
    return toWesternDigits(
      new Intl.DateTimeFormat(LOCALES[language], { ...options, timeZone: zone }).format(instant),
    );
  } catch {
    return null;
  }
}

/** One name or moment placeholder's value, or null when it cannot be shown (a word placeholder answers undefined). */
function placeholderValue(
  name: string,
  params: Readonly<Record<string, unknown>>,
  content: NoticeContent,
): string | null | undefined {
  if ((PUSH_NAME_PLACEHOLDERS as readonly string[]).includes(name)) {
    return pushName(params[name], content.language);
  }
  if (name === "date" || name === "time") {
    return pushMoment(params[name], name, content.timezone, content.language);
  }
  return PUSH_TERM_PLACEHOLDERS.includes(name) ? undefined : null;
}

/** The values for a text's placeholders, or null when one of its names or moments cannot be shown. */
function valuesFor(text: string, content: NoticeContent): Readonly<Record<string, string>> | null {
  const params = isRecord(content.params) ? content.params : {};
  const values: Record<string, string> = {
    ...wordParams(readEventTerms(content.terms), content.language),
  };
  for (const name of placeholdersOf(text)) {
    const shown = placeholderValue(name, params, content);
    if (shown === null) return null;
    if (shown !== undefined) values[name] = shown;
  }
  return values;
}

const textOf = (texts: PushTexts, key: string, language: Language): string =>
  texts.messages[key]?.[language] ?? "";

/**
 * Renders a notice in one language: its kind's template with the frozen names, or the nameless variant when a name is
 * missing or fails the rule; the title is the event's name, else "Questify". A kind without a template, or a nameless
 * variant that still cannot be filled, gives the generic text and is not pushed. Never throws.
 */
export function renderNotice(content: NoticeContent, texts: PushTexts = SHIPPED): RenderedNotice {
  const params = isRecord(content.params) ? content.params : {};
  const title =
    pushName(params["event"], content.language) ?? textOf(texts, "push.title", content.language);
  const template = texts.templates[content.kind];
  const generic = { title, body: textOf(texts, "push.generic.body", content.language) };
  if (template === undefined) return { ...generic, pushable: false };
  for (const key of [template.body, template.nameless]) {
    const text = textOf(texts, key, content.language);
    const values = text === "" ? null : valuesFor(text, content);
    if (values !== null) {
      return { title, body: interpolate(text, values, content.language), pushable: true };
    }
  }
  return { ...generic, pushable: false };
}

/**
 * Why a template's texts break the rules, or an empty list: both keys exist in both languages, every placeholder is on
 * the allowlist, the two languages hold the same placeholders, and the nameless body holds no name.
 */
export function pushTemplateIssues(
  template: PushTemplate,
  messages: Messages = MESSAGES,
): string[] {
  const issues: string[] = [];
  for (const key of [template.body, template.nameless]) {
    const pair = messages[key];
    if (pair === undefined) {
      issues.push(`${key}: no such text`);
      continue;
    }
    const ar = placeholdersOf(pair.ar);
    const en = placeholdersOf(pair.en);
    for (const name of [...new Set([...ar, ...en])].filter(
      (one) => !PUSH_PLACEHOLDERS.includes(one),
    )) {
      issues.push(`${key}: {${name}} is not allowed in a push`);
    }
    if (ar.join(",") !== en.join(",")) issues.push(`${key}: the languages differ in placeholders`);
    const named = ar.filter((one) => (PUSH_NAME_PLACEHOLDERS as readonly string[]).includes(one));
    if (key === template.nameless && named.length > 0) {
      issues.push(`${key}: a nameless body names {${named.join("}, {")}}`);
    }
  }
  return issues;
}
