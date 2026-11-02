import { z } from "zod";
import { JOIN_LINK_HOSTS } from "#src/join/link";
import { ARABIC_LETTER, adminText } from "#src/legal/admin";
import { smsParts } from "#src/messaging/sms";

/**
 * The message templates an admin edits (T-706, FR-1780) and the Saudi CST rules the console checks on save (ADR-065,
 * ADR-460): an SMS names its sender and its purpose, a promotional SMS or email carries the opt-out link, a promotional
 * SMS stays within 3 parts, and no template can hold a placeholder it is not given a value for. The database door
 * (`admin_message_template_save`, migration 0127) enforces the structural half again; the wording rules live here only,
 * as the invitation name rule does.
 */

export const MESSAGE_TEMPLATE_KEYS = [
  "login_code_sms",
  "promo_sms",
  "promo_email",
  "promo_push",
] as const;
export type MessageTemplateKey = (typeof MESSAGE_TEMPLATE_KEYS)[number];

export const isMessageTemplateKey = (value: unknown): value is MessageTemplateKey =>
  (MESSAGE_TEMPLATE_KEYS as readonly unknown[]).includes(value);

type Channel = "sms" | "email" | "push";

type Rule = Readonly<{
  channel: Channel;
  /** The longest title (email subject, push title); null for a channel without one. */
  titleMax: number | null;
  bodyMax: number;
  /** Placeholders the text must hold, and those it may hold. */
  required: readonly string[];
  allowed: readonly string[];
  /** Words that state what an SMS is for, per language; null when the opt-out line does that. */
  purpose: Readonly<{ ar: RegExp; en: RegExp }> | null;
}>;

/** The Arabic and Latin brand names every SMS carries so the reader knows the sender (ADR-019). */
export const SMS_BRAND = { ar: "كويستفاي", en: "Questify" } as const;
export const SMS_MAX_PARTS = 3;

/** The values a preview and the part count stand in for a placeholder with: the real lengths, never a real value. */
const SAMPLE_OPT_OUT = (language: "ar" | "en"): string =>
  `https://${JOIN_LINK_HOSTS[0]}/${language}/opt-out?t=${"X".repeat(44)}`;
const SAMPLE_VALUES: Readonly<Record<string, (language: "ar" | "en") => string>> = {
  code: () => "123456",
  optOutUrl: SAMPLE_OPT_OUT,
};

export const TEMPLATE_RULES: Readonly<Record<MessageTemplateKey, Rule>> = {
  login_code_sms: {
    channel: "sms",
    titleMax: null,
    bodyMax: 300,
    required: ["code"],
    allowed: ["code"],
    purpose: { ar: /رمز الدخول|رمز تسجيل الدخول/u, en: /sign-in code|login code/iu },
  },
  promo_sms: {
    channel: "sms",
    titleMax: null,
    bodyMax: 300,
    required: ["optOutUrl"],
    allowed: ["optOutUrl"],
    purpose: null,
  },
  promo_email: {
    channel: "email",
    titleMax: 150,
    bodyMax: 4000,
    required: ["optOutUrl"],
    allowed: ["optOutUrl"],
    purpose: null,
  },
  // A push has no link to write: the way out is Settings, and a push never carries a placeholder.
  promo_push: {
    channel: "push",
    titleMax: 60,
    bodyMax: 140,
    required: [],
    allowed: [],
    purpose: null,
  },
};

const pair = (max: number) => z.strictObject({ ar: adminText(max), en: adminText(max) });

/** What an admin sends for one template: both languages of the body, and of the title where the channel has one. */
export const messageTemplateDocSchema = z.strictObject({
  title: pair(150).nullable(),
  body: pair(4000),
});
export type MessageTemplateDoc = z.infer<typeof messageTemplateDocSchema>;

const stored = z.strictObject({ ar: z.string(), en: z.string() });

export const messageTemplateAdminSchema = z.strictObject({
  key: z.enum(MESSAGE_TEMPLATE_KEYS),
  title: stored.nullable(),
  body: stored,
  updatedAt: z.string(),
  revertible: z.boolean(),
});
export type MessageTemplateAdmin = z.infer<typeof messageTemplateAdminSchema>;
export const messageTemplateAdminListSchema = z.strictObject({
  templates: z.array(messageTemplateAdminSchema),
});

/** Why a template cannot be saved; the console shows the reason in the admin's language. */
export const TEMPLATE_ISSUES = [
  "required",
  "tooLong",
  "language",
  "titleNotAllowed",
  "placeholderUnknown",
  "placeholderMissing",
  "braces",
  "brandMissing",
  "purposeMissing",
  "smsPartsLimit",
] as const;
export type TemplateIssueCode = (typeof TEMPLATE_ISSUES)[number];

export type TemplateIssue = Readonly<{ path: string; message: TemplateIssueCode }>;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/gu;

/** The names between braces, in order of appearance. */
export function placeholdersIn(text: string): string[] {
  return Array.from(text.matchAll(PLACEHOLDER), (match) => match[1] ?? "");
}

/** The text with each placeholder replaced by a stand-in of the real length (a preview, and the SMS part count). */
export function fillSamples(text: string, language: "ar" | "en"): string {
  return text.replace(
    PLACEHOLDER,
    (whole, name: string) => SAMPLE_VALUES[name]?.(language) ?? whole,
  );
}

const writtenIn = (text: string, language: "ar" | "en"): boolean =>
  language === "ar" ? ARABIC_LETTER.test(text) : !ARABIC_LETTER.test(text);

function textIssues(
  rule: Rule,
  text: string,
  language: "ar" | "en",
  path: string,
): TemplateIssue[] {
  if (text === "") return [{ path, message: "required" }];
  if (!writtenIn(text, language)) return [{ path, message: "language" }];
  const issues: TemplateIssue[] = [];
  const names = placeholdersIn(text);
  if (names.some((name) => !rule.allowed.includes(name))) {
    issues.push({ path, message: "placeholderUnknown" });
  }
  if (rule.required.some((name) => !names.includes(name))) {
    issues.push({ path, message: "placeholderMissing" });
  }
  if (text.replace(PLACEHOLDER, "").match(/[{}]/u) !== null) {
    issues.push({ path, message: "braces" });
  }
  return issues;
}

function smsIssues(rule: Rule, text: string, language: "ar" | "en", path: string): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  if (!text.includes(SMS_BRAND[language])) issues.push({ path, message: "brandMissing" });
  if (rule.purpose !== null && !rule.purpose[language].test(text)) {
    issues.push({ path, message: "purposeMissing" });
  }
  if (smsParts(fillSamples(text, language)) > SMS_MAX_PARTS) {
    issues.push({ path, message: "smsPartsLimit" });
  }
  return issues;
}

function bodyIssues(rule: Rule, body: string, language: "ar" | "en"): TemplateIssue[] {
  const path = `body.${language}`;
  const issues = textIssues(rule, body, language, path);
  if (body.length > rule.bodyMax) issues.push({ path, message: "tooLong" });
  if (rule.channel === "sms" && body !== "") issues.push(...smsIssues(rule, body, language, path));
  return issues;
}

function titleIssues(
  rule: Rule,
  max: number,
  title: string,
  language: "ar" | "en",
): TemplateIssue[] {
  const path = `title.${language}`;
  const issues = textIssues({ ...rule, required: [], allowed: [] }, title, language, path);
  if (title.length > max) issues.push({ path, message: "tooLong" });
  return issues;
}

/**
 * Every CST and structure rule a template breaks, none when it can be saved. Both languages are checked and each issue
 * names its field (`body.ar`, `title.en`), so the form marks the box that is wrong.
 */
export function templateIssues(key: MessageTemplateKey, doc: MessageTemplateDoc): TemplateIssue[] {
  const rule = TEMPLATE_RULES[key];
  const issues: TemplateIssue[] = [];
  if (rule.titleMax === null && doc.title !== null) {
    issues.push({ path: "title", message: "titleNotAllowed" });
  }
  for (const language of ["ar", "en"] as const) {
    issues.push(...bodyIssues(rule, doc.body[language], language));
    if (rule.titleMax !== null) {
      issues.push(...titleIssues(rule, rule.titleMax, doc.title?.[language] ?? "", language));
    }
  }
  return issues;
}
