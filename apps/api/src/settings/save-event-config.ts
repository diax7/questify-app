import type { Pool } from "pg";
import {
  readBranding,
  layoutAfter,
  readEventLayout,
  readEventTexts,
  validateEventBranding,
  validateEventTerms,
  validateEventTexts,
  validateLayoutRequest,
} from "@questify/shared";
import { diff } from "#src/audit/entry";
import { recordAudit, type AuditMeta } from "#src/audit/record";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { LayoutSaveResult, SaveResult, TextsSaveResult } from "#src/settings/service";
import {
  lockEventBranding,
  lockEventLayout,
  lockEventTerms,
  lockEventTexts,
  writeEventBranding,
  writeEventLayout,
  writeEventTerms,
  writeEventTexts,
} from "#src/settings/store";
import { teamSeat } from "#src/organizers/store";

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
    withRequestContext(client, teamSeat(actor), async (): Promise<SaveResult> => {
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
    }),
  );
}

/**
 * Replaces the labels the event renamed (FR-1843, T-614): only the approved list, each cleaned and bounded, a label with a
 * lost or foreign placeholder refused, a blank one back to the platform's text. The check is the server's whatever the
 * dashboard sent. Any status but archived. Audited when it changes, with the author and the labels (no personal data).
 */
export async function saveTexts(
  pool: Pool,
  actor: Actor,
  eventId: string,
  input: unknown,
  meta: AuditMeta,
): Promise<TextsSaveResult> {
  const checked = validateEventTexts(input);
  if (!checked.ok) {
    return { ok: false, reason: "invalid", issues: checked.issues };
  }
  return withConnection(pool, (client) =>
    withRequestContext(client, teamSeat(actor), async (): Promise<TextsSaveResult> => {
      const stored = await lockEventTexts(client, eventId);
      if (stored === undefined) {
        return { ok: false, reason: "not_found" };
      }
      if (stored.archived) {
        return { ok: false, reason: "archived" };
      }
      const changes = diff({ texts: readEventTexts(stored.texts) }, { texts: checked.value });
      if ("texts" in changes.after) {
        await writeEventTexts(client, eventId, checked.value);
        await recordAudit(client, {
          actor: { type: "staff", id: actor.staffUserId },
          action: "event.texts.update",
          organizerId: stored.organizerId,
          eventId,
          target: { type: "event", id: eventId },
          ...changes,
          requestId: meta.requestId,
        });
      }
      return { ok: true, texts: checked.value };
    }),
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
    withRequestContext(client, teamSeat(actor), async (): Promise<SaveResult> => {
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
    }),
  );
}

/**
 * Replaces the event's layout (FR-1749, FR-1750, FR-1764, FR-1828 to FR-1831, T-606, T-610): an approved preset laid over the
 * event's cards and words, or the order, hidden set and content of the bar and Home. A layout that hides a protected item or
 * has more than five bar slots is refused here, whatever the dashboard sent, and the texts are cleaned and bounded here. Any
 * status but archived. Audited when it changes, with the author and the layout (no personal data is in it).
 */
export async function saveLayout(
  pool: Pool,
  actor: Actor,
  eventId: string,
  input: unknown,
  meta: AuditMeta,
): Promise<LayoutSaveResult> {
  const checked = validateLayoutRequest(input);
  if (!checked.ok) {
    return { ok: false, reason: "invalid", issues: checked.issues };
  }
  return withConnection(pool, (client) =>
    withRequestContext(client, teamSeat(actor), async (): Promise<LayoutSaveResult> => {
      const stored = await lockEventLayout(client, eventId);
      if (stored === undefined) {
        return { ok: false, reason: "not_found" };
      }
      if (stored.archived) {
        return { ok: false, reason: "archived" };
      }
      const current = readEventLayout(stored.layout);
      const layout = layoutAfter(checked.value, current);
      const changes = diff({ layout: current }, { layout });
      if ("layout" in changes.after) {
        await writeEventLayout(client, eventId, layout);
        await recordAudit(client, {
          actor: { type: "staff", id: actor.staffUserId },
          action: "event.layout.update",
          organizerId: stored.organizerId,
          eventId,
          target: { type: "event", id: eventId },
          ...changes,
          requestId: meta.requestId,
        });
      }
      return { ok: true, layout };
    }),
  );
}
