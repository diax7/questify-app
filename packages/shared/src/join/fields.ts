import type { Language } from "#src/i18n/digits";
import { MESSAGES, type MessageKey } from "#src/i18n/messages";

/** The kinds of join field an organizer may ask (FR-129); a custom one carries its own label. */
export const JOIN_FIELD_KINDS = [
  "full_name",
  "company",
  "job_title",
  "department",
  "ticket_number",
  "custom",
] as const;
export type JoinFieldKind = (typeof JOIN_FIELD_KINDS)[number];

const KIND_KEYS: Readonly<Record<JoinFieldKind, MessageKey>> = {
  full_name: "joinField.fullName",
  company: "joinField.company",
  job_title: "joinField.jobTitle",
  department: "joinField.department",
  ticket_number: "joinField.ticketNumber",
  custom: "joinField.custom",
};

/** The message that names a kind of field, for the dashboard's kind picker. */
export const joinFieldKindKey = (kind: JoinFieldKind): MessageKey => KIND_KEYS[kind];

/**
 * What a field is called in a language: a custom field's own label (the other language's when this one is empty),
 * else the kind's words. An unknown kind from a newer server reads as a custom field.
 */
export function joinFieldLabel(
  field: Readonly<{ kind: string; label: Readonly<{ ar: string | null; en: string | null }> }>,
  language: Language,
): string {
  const other: Language = language === "ar" ? "en" : "ar";
  const own = [field.label[language], field.label[other]].find(
    (text) => text !== null && text !== "",
  );
  if (own !== undefined && own !== null) {
    return own;
  }
  const key = KIND_KEYS[field.kind as JoinFieldKind] ?? KIND_KEYS.custom;
  return MESSAGES[key][language];
}
