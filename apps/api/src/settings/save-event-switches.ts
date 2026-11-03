import {
  eventLayersOf,
  readEventSwitches,
  type EventLayers,
  type Registries,
} from "@questify/shared";
import type { Pool } from "pg";
import { diff } from "#src/audit/entry";
import { recordAudit, type AuditMeta } from "#src/audit/record";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { readEventRequests } from "#src/settings/feature-requests";
import { firstSwitchOnRefused, readEventLayerInputs } from "#src/settings/layers";
import type { SaveResult } from "#src/settings/service";
import { lockEventSwitches, readEventOrganizerId, writeEventSwitches } from "#src/settings/store";
import { teamSeat, type OrganizerContext } from "#src/organizers/store";

/** The organizer member saving; a support view (T-712) carries `readOnly`, so its seat cannot write. */
export type SwitchActor = OrganizerContext;

/** The switches an event will hold, and which of them this save asks for. */
export type SwitchChange = Readonly<{
  next: Readonly<Record<string, boolean>>;
  /** The switches this save asks for, of which every one set on must be allowed (FR-1826, FR-1827). */
  requested: Readonly<Record<string, boolean>>;
}>;

/**
 * Replaces an event's feature switches under the event's row lock, writes the audit entry, and refuses (writing nothing)
 * a switch-on that the platform, the organizer's override or Questify's add-on rule does not allow.
 */
export async function saveSwitches(
  pool: Pool,
  registries: Registries,
  actor: SwitchActor,
  eventId: string,
  change: (before: Readonly<Record<string, boolean>>) => SwitchChange,
  meta: AuditMeta,
): Promise<SaveResult> {
  const outcome = await withConnection(pool, (client) =>
    withRequestContext(
      client,
      teamSeat(actor),
      async (): Promise<"saved" | "missing" | "not_allowed"> => {
        const current = await lockEventSwitches(client, eventId);
        if (current === undefined) {
          return "missing";
        }
        const before = readEventSwitches({ features: current.features });
        const { next, requested } = change(before);
        if ((await firstSwitchOnRefused(client, registries, eventId, requested)) !== undefined) {
          return "not_allowed";
        }
        const changes = diff({ features: before }, { features: next });
        if ("features" in changes.after) {
          await writeEventSwitches(client, eventId, next);
          await recordAudit(client, {
            actor: { type: "staff", id: actor.staffUserId },
            action: "event.features.update",
            organizerId: current.organizerId,
            eventId,
            target: { type: "event", id: eventId },
            ...changes,
            requestId: meta.requestId,
          });
        }
        return "saved";
      },
    ),
  );
  if (outcome === "saved") {
    return { ok: true };
  }
  return { ok: false, reason: outcome === "missing" ? "not_found" : "not_allowed" };
}

/**
 * What a member of the organizer sees of an event's features, each add-on with the owner's latest Ask Questify request, or
 * undefined when the event is not the organizer's. A public event of another organizer is visible to every caller, so the
 * owner is checked here as well as by the database.
 */
export function readOwnerLayers(
  pool: Pool,
  registries: Registries,
  actor: SwitchActor,
  eventId: string,
): Promise<EventLayers | undefined> {
  return withConnection(pool, (client) =>
    withRequestContext(client, teamSeat(actor), async () => {
      if ((await readEventOrganizerId(client, eventId)) !== actor.organizerId) {
        return undefined;
      }
      const inputs = await readEventLayerInputs(client, registries, eventId);
      return inputs === undefined
        ? undefined
        : eventLayersOf(
            registries,
            inputs.platform,
            inputs.event,
            await readEventRequests(client, eventId),
          );
    }),
  );
}
