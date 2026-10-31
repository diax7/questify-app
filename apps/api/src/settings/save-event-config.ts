import type { Pool } from "pg";
import {
  readBranding,
  readEventLayout,
  validateEventBranding,
  validateEventTerms,
  validateLayoutRequest,
} from "@questify/shared";
import { diff } from "#src/audit/entry";
import { recordAudit, type AuditMeta } from "#src/audit/record";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { SaveResult } from "#src/settings/service";
import {
  lockEventBranding,
  lockEventLayout,
  lockEventTerms,
  writeEventBranding,
  writeEventLayout,
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

/**
 * Replaces the event's layout (FR-1749, FR-1750, FR-1764, T-606): an approved preset by name, or the order and hidden set of the
 * bar and Home. A layout that hides a protected item or has more than five bar slots is refused here, whatever the dashboard
 * sent. Any status but archived. Audited when it changes.
 */
export async function saveLayout(
  pool: Pool,
  actor: Actor,
  eventId: string,
  input: unknown,
  meta: AuditMeta,
): Promise<SaveResult> {
  const checked = validateLayoutRequest(input);
  if (!checked.ok) {
    return { ok: false, reason: "invalid", issues: checked.issues };
  }
  return withConnection(pool, (client) =>
    withRequestContext(
      client,
      { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
      async (): Promise<SaveResult> => {
        const current = await lockEventLayout(client, eventId);
        if (current === undefined) {
          return { ok: false, reason: "not_found" };
        }
        if (current.archived) {
          return { ok: false, reason: "archived" };
        }
        const changes = diff(
          { layout: readEventLayout(current.layout) },
          { layout: checked.value },
        );
        if ("layout" in changes.after) {
          await writeEventLayout(client, eventId, checked.value);
          await recordAudit(client, {
            actor: { type: "staff", id: actor.staffUserId },
            action: "event.layout.update",
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
