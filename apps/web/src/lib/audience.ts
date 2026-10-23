import { joinOptionLabel, type JoinOption, type Language } from "@questify/shared";

type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

/** A rule as `GET …/events/{eventId}/audience` answers it (T-220, ADR-170); null is everyone. */
export type AudienceRule =
  | Readonly<{ kind: "answer"; fieldId: string; values: readonly string[] }>
  | Readonly<{ kind: "tag"; values: readonly string[] }>;

export type AudienceItem = Readonly<{
  id: string;
  name: Bilingual;
  audience: AudienceRule | null;
  members: number | null;
  removed: boolean;
}>;

export type ChoiceField = Readonly<{
  id: string;
  label: Bilingual;
  options: readonly JoinOption[];
}>;

export type AudienceView = Readonly<{
  fields: readonly ChoiceField[];
  tags: readonly Readonly<{ tag: string; guests: number }>[];
  categories: readonly AudienceItem[];
  rewards: readonly AudienceItem[];
}>;

/** The editor's state: who may see the item, with the field and values picked so far. */
export type AudienceDraft = Readonly<{
  kind: "everyone" | "answer" | "tag";
  fieldId: string;
  values: readonly string[];
}>;

/** A name in a language, else in the other one. */
export const nameIn = (name: Bilingual, language: Language): string =>
  name[language] ?? name[language === "ar" ? "en" : "ar"] ?? "";

export function draftOf(rule: AudienceRule | null, fields: readonly ChoiceField[]): AudienceDraft {
  if (rule === null) {
    return { kind: "everyone", fieldId: fields[0]?.id ?? "", values: [] };
  }
  return rule.kind === "answer"
    ? { kind: "answer", fieldId: rule.fieldId, values: rule.values }
    : { kind: "tag", fieldId: fields[0]?.id ?? "", values: rule.values };
}

/** Ticks or unticks one value; tags compare without case, as the server matches them. */
export function toggleValue(draft: AudienceDraft, value: string): AudienceDraft {
  const same = (other: string) =>
    draft.kind === "tag" ? other.toLowerCase() === value.toLowerCase() : other === value;
  return draft.values.some(same)
    ? { ...draft, values: draft.values.filter((other) => !same(other)) }
    : { ...draft, values: [...draft.values, value] };
}

/** Whether a value is ticked in the draft. */
export const hasValue = (draft: AudienceDraft, value: string): boolean =>
  draft.values.some((other) =>
    draft.kind === "tag" ? other.toLowerCase() === value.toLowerCase() : other === value,
  );

/** The body of `PUT …/audience/{categories|rewards}/{id}`; undefined while a rule has nothing picked. */
export function ruleBody(draft: AudienceDraft): { rule: AudienceRule | null } | undefined {
  if (draft.kind === "everyone") {
    return { rule: null };
  }
  if (draft.values.length === 0 || (draft.kind === "answer" && draft.fieldId === "")) {
    return undefined;
  }
  return draft.kind === "answer"
    ? { rule: { kind: "answer", fieldId: draft.fieldId, values: draft.values } }
    : { rule: { kind: "tag", values: draft.values } };
}

/** Picking another field starts its options afresh: another field's option ids mean nothing here. */
export const pickField = (draft: AudienceDraft, fieldId: string): AudienceDraft => ({
  ...draft,
  fieldId,
  values: draft.fieldId === fieldId ? draft.values : [],
});

/** Switching between everyone, an answer and a tag clears what was picked for the other kind. */
export const pickKind = (draft: AudienceDraft, kind: AudienceDraft["kind"]): AudienceDraft => ({
  ...draft,
  kind,
  values: draft.kind === kind ? draft.values : [],
});

/**
 * Who sees an item, in words: null for everyone; else the field and its options, or the tags. A value no longer on
 * the field (or a field gone) shows as it is stored, so nothing is hidden from the organizer.
 */
export function ruleWords(
  rule: AudienceRule | null,
  fields: readonly ChoiceField[],
  language: Language,
): Readonly<{ field: string | null; values: string }> | null {
  if (rule === null) {
    return null;
  }
  const separator = language === "ar" ? "، " : ", ";
  if (rule.kind === "tag") {
    return { field: null, values: rule.values.join(separator) };
  }
  const field = fields.find((entry) => entry.id === rule.fieldId);
  const values = rule.values.map((id) => {
    const option = field?.options.find((entry) => entry.id === id);
    return option === undefined ? id : joinOptionLabel(option, language);
  });
  return {
    field: field === undefined ? null : nameIn(field.label, language),
    values: values.join(separator),
  };
}
