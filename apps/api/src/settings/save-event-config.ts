import type { Pool } from "pg";
import { readBranding, validateEventBranding, validateEventTerms } from "@questify/shared";
import { diff } from "#src/audit/entry";
import { recordAudit, type AuditMeta } from "#src/audit/record";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { SaveResult } from "#src/settings/service";
import {
  lockEventBranding,
  lockEventTerms,
  writeEventBranding,
  writeEventTerms,
} from "#src/settings/store";

type Actor = Readonly<{ staffUserId: string; organizerId: string }>;

/**
 * Replaces the event's words (FR-404, FR-940): a word left out returns to the default. Any status but archived, since a
 * name can be fixed after the event. Audited when it changes.
 */
export async function saveTerms(
  pool: Pool,
  actor: Actor,
  eventId: string,
  input: unknown,
  meta: AuditMeta,
): Promise<SaveResult> {
  const checked = validateEventTerms(input);
  if (!checked.ok) {
    return { ok: false, reason: "invalid", issues: checked.issues };
  }
  return withConnection(pool, (client) =>
    withRequestContext(
      client,
      { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
      async (): Promise<SaveResult> => {
        const current = await lockEventTerms(client, eventId);
        if (current === undefined) {
          return { ok: false, reason: "not_found" };
        }
        if (current.archived) {
          return { ok: false, reason: "archived" };
        }
        const changes = diff({ terms: current.terms ?? {} }, { terms: checked.value });
        if ("terms" in changes.after) {
          await writeEventTerms(client, eventId, checked.value);
          await recordAudit(client, {
            actor: { type: "staff", id: actor.staffUserId },
            action: "event.terms.update",
            organizerId: current.organizerId,
            eventId,
            target: { type: "event", id: eventId },
            ...changes,
            requestId: meta.requestId,
          });
        }
        return { ok: true };
      },
    ),
  );
}

/**
 * Picks the event's accent colour from the curated list, or null for the brand colour (FR-1023, T-602). Any status but
 * archived. Audited when it changes.
 */
export async function saveBranding(
  pool: Pool,
  actor: Actor,
  eventId: string,
  input: unknown,
  meta: AuditMeta,
): Promise<SaveResult> {
  const checked = validateEventBranding(input);
  if (!checked.ok) {
    return { ok: false, reason: "invalid", issues: checked.issues };
  }
  return withConnection(pool, (client) =>
    withRequestContext(
      client,
      { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
      async (): Promise<SaveResult> => {
        const current = await lockEventBranding(client, eventId);
        if (current === undefined) {
          return { ok: false, reason: "not_found" };
        }
        if (current.archived) {
          return { ok: false, reason: "archived" };
        }
        const changes = diff(
          { branding: readBranding(current.branding) },
          { branding: checked.value },
        );
        if ("branding" in changes.after) {
          await writeEventBranding(client, eventId, checked.value);
          await recordAudit(client, {
            actor: { type: "staff", id: actor.staffUserId },
            action: "event.branding.update",
            organizerId: current.organizerId,
            eventId,
            target: { type: "event", id: eventId },
            ...changes,
            requestId: meta.requestId,
          });
        }
        return { ok: true };
      },
    ),
  );
}
