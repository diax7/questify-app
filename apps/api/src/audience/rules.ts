import type { JoinOption } from "@questify/shared";

/** A targeting rule (ADR-170): the chosen options of one choice field, or a set of guest tags. */
export type AudienceRule =
  | Readonly<{ kind: "answer"; fieldId: string; values: readonly string[] }>
  | Readonly<{ kind: "tag"; values: readonly string[] }>;

/** The rule columns of a category or a reward (migration 0037). */
export type RuleColumns = Readonly<{
  audience_kind: "answer" | "tag" | null;
  audience_field_id: string | null;
  audience_values: string[] | null;
}>;

/** The rule a row holds; null for everyone. */
export function ruleOf(row: RuleColumns): AudienceRule | null {
  const values = row.audience_values ?? [];
  if (row.audience_kind === "answer" && row.audience_field_id !== null) {
    return { kind: "answer", fieldId: row.audience_field_id, values };
  }
  return row.audience_kind === "tag" ? { kind: "tag", values } : null;
}

/** The arguments `set_audience` takes for a rule: kind, field, values (all null for everyone). */
export function ruleArgs(
  rule: AudienceRule | null,
): [string | null, string | null, readonly string[] | null] {
  if (rule === null) {
    return [null, null, null];
  }
  return [rule.kind, rule.kind === "answer" ? rule.fieldId : null, rule.values];
}

export type ItemName = Readonly<{ ar: string | null; en: string | null }>;

/** A category or reward with a rule by answer, as the field save checks it. */
export type TargetedItem = Readonly<{
  kind: "category" | "reward";
  name: ItemName;
  fieldId: string;
  values: readonly string[];
}>;

/** What the event's members answered to one field: whether anyone did, and the option ids chosen. */
export type FieldAnswers = Readonly<{ fieldId: string; chosen: readonly string[] }>;

export type FieldState = Readonly<{ id: string; options: readonly JoinOption[] | null }>;

/** Why a field save is refused: an answer or a rule (with the items it targets) names what would go. */
export type FieldInUse =
  | Readonly<{ reason: "answers" }>
  | Readonly<{ reason: "rules"; categories: ItemName[]; rewards: ItemName[] }>;

const idsOf = (options: readonly JoinOption[] | null): string[] =>
  (options ?? []).map((option) => option.id);

/**
 * Whether saving `after` over `before` would take away a field or an option something still names (ADR-173, the T-220
 * review): a deleted field or a removed option a rule names; an option an answer names; options added to a field
 * that has free-text answers. `after` holds the kept fields by id; a field missing from it is deleted (its answers go
 * with it, which the dashboard confirms first). Rules are reported first, with the items they target.
 */
export function fieldsInUse(
  before: readonly FieldState[],
  after: ReadonlyMap<string, readonly JoinOption[] | null>,
  answers: readonly FieldAnswers[],
  targeted: readonly TargetedItem[],
): FieldInUse | undefined {
  const blocking: TargetedItem[] = [];
  let answered = false;
  for (const field of before) {
    const kept = after.has(field.id);
    const next = after.get(field.id) ?? null;
    const nextIds = new Set(idsOf(next));
    const removed = idsOf(field.options).filter((id) => !nextIds.has(id));
    for (const item of targeted) {
      const named = item.fieldId === field.id;
      if (named && (!kept || next === null || item.values.some((id) => removed.includes(id)))) {
        blocking.push(item);
      }
    }
    const given = answers.find((entry) => entry.fieldId === field.id);
    if (kept && given !== undefined) {
      const addsOptions = field.options === null && next !== null;
      answered ||= addsOptions || given.chosen.some((id) => removed.includes(id));
    }
  }
  if (blocking.length > 0) {
    const names = (kind: TargetedItem["kind"]) =>
      blocking.filter((item) => item.kind === kind).map((item) => item.name);
    return { reason: "rules", categories: names("category"), rewards: names("reward") };
  }
  return answered ? { reason: "answers" } : undefined;
}
