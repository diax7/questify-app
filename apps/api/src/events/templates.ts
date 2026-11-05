import type { PoolClient } from "pg";
import type { ZodError } from "zod";
import { applyPreset, presetLayout, templateRowSchema, type TemplateRow } from "@questify/shared";
import { readEvent } from "#src/events/store";
import { writeEventLayout } from "#src/settings/store";

/** The SQLSTATE `event_apply_template` raises for a key that is unknown or switched off (migration 0115). */
export const UNKNOWN_TEMPLATE = "ET404";
/** The SQLSTATE it raises for an event that is not an empty draft (T-601's rule). */
export const NOT_EMPTY = "ED409";

/** Where a template row that fails the schema is reported. */
export type TemplateLog = (level: "warn", fields: Readonly<Record<string, string>>) => void;

async function storedTemplates(client: PoolClient): Promise<unknown[]> {
  const { rows } = await client.query<{ list: unknown[] }>("SELECT event_templates() AS list");
  return rows[0]?.list ?? [];
}

function problemOf(stored: unknown, error: ZodError): { key: string; problem: string } {
  const issue = error.issues[0];
  return {
    key: String((stored as { key?: unknown }).key),
    problem: issue === undefined ? "" : `${issue.path.join(".")}: ${issue.message}`,
  };
}

/**
 * The enabled templates, in order. Every body is checked against the shared schema here; a template the Questify console
 * saved badly is left out of the list and logged with its key named, so one bad row never hides the others.
 */
export async function readTemplates(client: PoolClient, log: TemplateLog): Promise<TemplateRow[]> {
  const templates: TemplateRow[] = [];
  for (const stored of await storedTemplates(client)) {
    const parsed = templateRowSchema.safeParse(stored);
    if (parsed.success) {
      templates.push(parsed.data);
    } else {
      log("warn", { event: "event_template.invalid", ...problemOf(stored, parsed.error) });
    }
  }
  return templates;
}

/**
 * Whether a key names an enabled template. Only the named row is checked, so a bad row of another template never stops this
 * one; a bad row of this key stops here with the key named, never half-way through a new event.
 */
export async function templateExists(client: PoolClient, key: string): Promise<boolean> {
  const stored = (await storedTemplates(client)).find(
    (row) => (row as { key?: unknown }).key === key,
  );
  if (stored === undefined) {
    return false;
  }
  const parsed = templateRowSchema.safeParse(stored);
  if (!parsed.success) {
    const { problem } = problemOf(stored, parsed.error);
    throw new Error(
      `The event template "${key}" is not valid at ${problem}. Fix its row in event_template.`,
    );
  }
  return true;
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
