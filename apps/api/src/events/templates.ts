import type { PoolClient } from "pg";
import { applyPreset, presetLayout, templateRowSchema, type TemplateRow } from "@questify/shared";
import { readEvent } from "#src/events/store";
import { writeEventLayout } from "#src/settings/store";

/** The SQLSTATE `event_apply_template` raises for a key that is unknown or switched off (migration 0115). */
export const UNKNOWN_TEMPLATE = "ET404";
/** The SQLSTATE it raises for an event that is not an empty draft (T-601's rule). */
export const NOT_EMPTY = "ED409";

/**
 * The enabled templates, in order. Every body is checked against the shared schema here, so a template the Questify console
 * saved badly stops at the read with its key named, never half-way through a new event.
 */
export async function readTemplates(client: PoolClient): Promise<TemplateRow[]> {
  const { rows } = await client.query<{ list: unknown[] }>("SELECT event_templates() AS list");
  return (rows[0]?.list ?? []).map((stored) => {
    const parsed = templateRowSchema.safeParse(stored);
    if (parsed.success) {
      return parsed.data;
    }
    const key = (stored as { key?: unknown }).key;
    const issue = parsed.error.issues[0];
    const at = issue === undefined ? "" : ` at ${issue.path.join(".")}: ${issue.message}`;
    throw new Error(
      `The event template "${String(key)}" is not valid${at}. Fix its row in event_template.`,
    );
  });
}

/** Whether a key names an enabled template. */
export async function templateExists(client: PoolClient, key: string): Promise<boolean> {
  return (await readTemplates(client)).some((template) => template.key === key);
}

/**
 * Fills the empty draft from the template (migration 0115's door), then lays the template's layout preset over the event's
 * layout in the same transaction. Throws the door's own refusals (ET404, ED409, AN404) for the caller to map.
 */
export async function fillFromTemplate(
  client: PoolClient,
  organizerId: string,
  eventId: string,
  key: string,
  requestId: string | undefined,
): Promise<void> {
  const { rows } = await client.query<{ applied: { layoutPreset: string } }>(
    "SELECT event_apply_template($1, $2, $3) AS applied",
    [eventId, key, requestId ?? null],
  );
  const preset = presetLayout(rows[0]?.applied.layoutPreset ?? "");
  const event = await readEvent(client, organizerId, eventId);
  if (preset !== undefined && event !== undefined) {
    await writeEventLayout(client, eventId, applyPreset(event.layout, preset));
  }
}
