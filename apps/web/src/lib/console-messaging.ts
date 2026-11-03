import {
  SUPPORT_EMAIL,
  SUPPORT_EMAIL_MAX,
  SUPPORT_PHONE,
  TEMPLATE_RULES,
  messageTemplateAdminListSchema,
  messageTemplateDocSchema,
  supportContactAdminSchema,
  templateIssues,
  type MessageKey,
  type MessageTemplateAdmin,
  type MessageTemplateDoc,
  type MessageTemplateKey,
  type SupportContact,
  type SupportContactAdmin,
  type TemplateIssueCode,
} from "@questify/shared";
import type { Checked } from "#src/lib/console-catalog.ts";

/** The console's message templates and support contact (T-706, FR-1780, FR-1731). */
export const TEMPLATES_API = "/v1/admin/message-templates";
export const CONTACT_API = "/v1/admin/support-contact";

/** The message holding each template's name. */
export const TEMPLATE_NAMES = {
  login_code_sms: "console.messages.key.loginCodeSms",
  promo_sms: "console.messages.key.promoSms",
  promo_email: "console.messages.key.promoEmail",
  promo_push: "console.messages.key.promoPush",
} as const satisfies Record<MessageTemplateKey, MessageKey>;

export const MESSAGING_TABS = ["templates", "push", "contact"] as const;
export type MessagingTab = (typeof MESSAGING_TABS)[number];

/** Each reader answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readTemplates(body: unknown): MessageTemplateAdmin[] | undefined {
  const parsed = messageTemplateAdminListSchema.safeParse(body);
  return parsed.success ? parsed.data.templates : undefined;
}

export function readContact(body: unknown): SupportContactAdmin | undefined {
  const contact =
    typeof body === "object" && body !== null ? Reflect.get(body, "contact") : undefined;
  const parsed = supportContactAdminSchema.safeParse(contact);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------- templates

export type TemplateDraft = Readonly<{
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
}>;

export const templateDraftOf = (row: MessageTemplateAdmin): TemplateDraft => ({
  titleAr: row.title?.ar ?? "",
  titleEn: row.title?.en ?? "",
  bodyAr: row.body.ar,
  bodyEn: row.body.en,
});

/** Whether the template has a title (an email subject, a push title): the SMS templates have none. */
export const hasTitle = (key: MessageTemplateKey): boolean => TEMPLATE_RULES[key].titleMax !== null;

/** The placeholders a template takes, for the hint under its text. */
export const placeholdersOf = (key: MessageTemplateKey): readonly string[] =>
  TEMPLATE_RULES[key].allowed;

export type TemplateCheck = Readonly<{
  /** Each field the rules refuse (`body.ar`) with the reasons, as message-key suffixes. */
  problems: ReadonlyMap<string, readonly TemplateIssueCode[]>;
}>;

/** The CST rules applied to what is typed, the same ones the API applies (`templateIssues`). */
export function checkTemplate(
  key: MessageTemplateKey,
  draft: TemplateDraft,
): Checked<MessageTemplateDoc> & TemplateCheck {
  const doc = {
    title: hasTitle(key) ? { ar: draft.titleAr, en: draft.titleEn } : null,
    body: { ar: draft.bodyAr, en: draft.bodyEn },
  };
  const parsed = messageTemplateDocSchema.safeParse(doc);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.map(String).join("."));
    return {
      ok: false,
      fields: new Set(fields),
      messages: parsed.error.issues.map((issue) => issue.message),
      problems: new Map(),
    };
  }
  const problems = new Map<string, TemplateIssueCode[]>();
  for (const issue of templateIssues(key, parsed.data)) {
    problems.set(issue.path, [...(problems.get(issue.path) ?? []), issue.message]);
  }
  if (problems.size > 0) {
    return {
      ok: false,
      fields: new Set(problems.keys()),
      messages: [...problems.values()].flat(),
      problems,
    };
  }
  return { ok: true, doc: parsed.data, problems };
}

export function isTemplateDirty(row: MessageTemplateAdmin, draft: TemplateDraft): boolean {
  const same = templateDraftOf(row);
  return (
    same.titleAr !== draft.titleAr.trim() ||
    same.titleEn !== draft.titleEn.trim() ||
    same.bodyAr !== draft.bodyAr.trim() ||
    same.bodyEn !== draft.bodyEn.trim()
  );
}

// ---------------------------------------------------------------- the support contact

export type ContactDraft = Readonly<{ whatsapp: string; phone: string; email: string }>;

export const contactDraftOf = (row: SupportContactAdmin): ContactDraft => ({
  whatsapp: row.whatsapp ?? "",
  phone: row.phone ?? "",
  email: row.email ?? "",
});

const emptyAsNull = (text: string): string | null => (text.trim() === "" ? null : text.trim());

/** The fields that are not valid; an empty field is valid (it is not shown). */
export function contactProblems(draft: ContactDraft): ReadonlySet<keyof ContactDraft> {
  const wrong = new Set<keyof ContactDraft>();
  for (const field of ["whatsapp", "phone"] as const) {
    const value = draft[field].trim();
    if (value !== "" && !SUPPORT_PHONE.test(value)) {
      wrong.add(field);
    }
  }
  const email = draft.email.trim();
  if (email !== "" && (email.length > SUPPORT_EMAIL_MAX || !SUPPORT_EMAIL.test(email))) {
    wrong.add("email");
  }
  return wrong;
}

export const contactDocOf = (draft: ContactDraft): SupportContact => ({
  whatsapp: emptyAsNull(draft.whatsapp),
  phone: emptyAsNull(draft.phone),
  email: emptyAsNull(draft.email),
});

export function isContactDirty(row: SupportContactAdmin, draft: ContactDraft): boolean {
  const same = contactDraftOf(row);
  return (
    same.whatsapp !== draft.whatsapp.trim() ||
    same.phone !== draft.phone.trim() ||
    same.email !== draft.email.trim()
  );
}
