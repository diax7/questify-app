import type { Pool, PoolClient } from "pg";
import type { JoinOption } from "@questify/shared";
import {
  ruleArgs,
  ruleOf,
  type AudienceRule,
  type FieldAnswers,
  type ItemName,
  type RuleColumns,
  type TargetedItem,
} from "#src/audience/rules";
import { onlyRow } from "#src/db/rows";
import { asOrganizer, ownEvent } from "#src/moderation/moderation";
import type { OrganizerContext } from "#src/organizers/store";

export type AudienceDeps = Readonly<{ pool: Pool }>;
export type ItemKind = "category" | "reward";

/** A category or reward with its rule and how many members it reaches now (null for everyone). */
export type AudienceItem = Readonly<{
  id: string;
  name: ItemName;
  audience: AudienceRule | null;
  members: number | null;
  /** A removed reward still holding a rule: listed so its rule can be cleared before its field goes. */
  removed: boolean;
}>;

/** What the "Who sees what" panel needs (T-220): the choice fields, the guest tags, every category and reward. */
export type AudienceView = Readonly<{
  fields: readonly Readonly<{
    id: string;
    label: ItemName;
    options: readonly JoinOption[];
  }>[];
  tags: readonly Readonly<{ tag: string; guests: number }>[];
  categories: readonly AudienceItem[];
  rewards: readonly AudienceItem[];
}>;

export type SetOutcome =
  | Readonly<{ kind: "done"; item: AudienceItem }>
  | Readonly<{ kind: "not_found" | "archived" | "invalid" }>;

type ItemRow = RuleColumns & {
  id: string;
  name_ar: string | null;
  name_en: string | null;
  removed: boolean;
};

const ITEM_SQL: Readonly<Record<ItemKind, string>> = {
  category: `SELECT id, name_ar, name_en, audience_kind, audience_field_id, audience_values, false AS removed
             FROM category WHERE event_id = $1 ORDER BY position, id`,
  reward: `SELECT id, name_ar, name_en, audience_kind, audience_field_id, audience_values,
                  status = 'removed' AS removed
           FROM reward WHERE event_id = $1 AND (status = 'active' OR audience_kind IS NOT NULL)
           ORDER BY status = 'removed', position, id`,
};

async function readCounts(client: PoolClient, eventId: string): Promise<Map<string, number>> {
  const { rows } = await client.query<{ item_id: string; members: number }>(
    "SELECT item_id, members FROM audience_counts($1)",
    [eventId],
  );
  return new Map(rows.map((row) => [row.item_id, row.members]));
}

async function readItems(
  client: PoolClient,
  eventId: string,
  kind: ItemKind,
  counts: ReadonlyMap<string, number>,
): Promise<AudienceItem[]> {
  const { rows } = await client.query<ItemRow>(ITEM_SQL[kind], [eventId]);
  return rows.map((row) => ({
    id: row.id,
    name: { ar: row.name_ar, en: row.name_en },
    audience: ruleOf(row),
    members: counts.get(row.id) ?? null,
    removed: row.removed,
  }));
}

/** The event's targeting setup for its owner and editors in scope; null when the event is not theirs to see. */
export function readAudience(
  deps: AudienceDeps,
  context: OrganizerContext,
  eventId: string,
): Promise<AudienceView | null> {
  return asOrganizer(deps, context, async (client) => {
    if (!(await ownEvent(client, context, eventId))) {
      return null;
    }
    const fields = await client.query<{
      id: string;
      label_ar: string | null;
      label_en: string | null;
      options: JoinOption[];
    }>(
      `SELECT id, label_ar, label_en, options FROM event_join_field
       WHERE event_id = $1 AND options IS NOT NULL ORDER BY position, id`,
      [eventId],
    );
    const tags = await client.query<{ tag: string; guests: number }>(
      `SELECT min(tag) AS tag, count(*)::int AS guests FROM event_guest
       WHERE event_id = $1 AND tag IS NOT NULL GROUP BY lower(tag) ORDER BY lower(tag)`,
      [eventId],
    );
    const counts = await readCounts(client, eventId);
    return {
      fields: fields.rows.map((row) => ({
        id: row.id,
        label: { ar: row.label_ar, en: row.label_en },
        options: row.options,
      })),
      tags: tags.rows,
      categories: await readItems(client, eventId, "category", counts),
      rewards: await readItems(client, eventId, "reward", counts),
    };
  });
}

/**
 * Sets or clears the rule of one category or reward (ADR-170). The database checks the caller, the event lock and
 * the options again, and audits ids and counts only.
 */
export function setAudience(
  deps: AudienceDeps,
  context: OrganizerContext,
  request: Readonly<{
    eventId: string;
    kind: ItemKind;
    itemId: string;
    rule: AudienceRule | null;
    requestId: string;
  }>,
): Promise<SetOutcome> {
  return asOrganizer(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: string }>(
      "SELECT set_audience($1, $2, $3, $4, $5, $6, $7) AS outcome",
      [request.eventId, request.kind, request.itemId, ...ruleArgs(request.rule), request.requestId],
    );
    const { outcome } = onlyRow(rows, "set_audience");
    if (outcome === "not_found" || outcome === "archived" || outcome === "invalid") {
      return { kind: outcome };
    }
    const counts = await readCounts(client, request.eventId);
    const items = await readItems(client, request.eventId, request.kind, counts);
    const item = items.find((entry) => entry.id === request.itemId);
    return item === undefined ? { kind: "not_found" } : { kind: "done", item };
  });
}

/** What the field save checks against (ADR-173): the answers per field and every rule by answer, with names. */
export async function readFieldUse(
  client: PoolClient,
  eventId: string,
): Promise<Readonly<{ answers: FieldAnswers[]; targeted: TargetedItem[] }>> {
  const answers = await client.query<{ field_id: string; chosen: string[] }>(
    `SELECT a.field_id,
            coalesce(array_agg(DISTINCT a.value) FILTER (WHERE f.options IS NOT NULL), '{}') AS chosen
     FROM join_answer a JOIN event_join_field f ON f.id = a.field_id
     WHERE a.event_id = $1 GROUP BY a.field_id`,
    [eventId],
  );
  const targeted = await client.query<{
    kind: ItemKind;
    name_ar: string | null;
    name_en: string | null;
    field_id: string;
    chosen: string[];
  }>(
    `SELECT 'category' AS kind, name_ar, name_en, audience_field_id AS field_id, audience_values AS chosen
     FROM category WHERE event_id = $1 AND audience_field_id IS NOT NULL
     UNION ALL
     SELECT 'reward', name_ar, name_en, audience_field_id, audience_values
     FROM reward WHERE event_id = $1 AND audience_field_id IS NOT NULL`,
    [eventId],
  );
  return {
    answers: answers.rows.map((row) => ({ fieldId: row.field_id, chosen: row.chosen })),
    targeted: targeted.rows.map((row) => ({
      kind: row.kind,
      name: { ar: row.name_ar, en: row.name_en },
      fieldId: row.field_id,
      values: row.chosen,
    })),
  };
}
