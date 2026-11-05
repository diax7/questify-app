import type { FastifyReply, FastifyRequest } from "fastify";
import { notFound } from "#src/auth/http-errors";
import type { SupportGrant } from "#src/auth/staff-store";
import { BUCKETS } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { holdBackAdmin, type AdminLimitDeps } from "#src/console/throttle";
import type { DeviceLimit } from "#src/devices/limits";
import { routeKeyOf } from "#src/organizers/support-seat";

/** A support view's reads: 240 a minute per admin (ADR-523), so a runaway page cannot flood the audit log. */
export const SUPPORT_VIEW_LIMIT = {
  bucket: BUCKETS.supportView,
  max: 240,
  windowSeconds: 60,
} as const satisfies DeviceLimit;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The organizer and the event are columns of the log row already. */
const IN_COLUMNS = new Set(["organizerId", "eventId"]);
const MAX_IDS = 4;

/** True for GET and HEAD, the only methods a view may use. */
export const isRead = (method: string): boolean => method === "GET" || method === "HEAD";

/**
 * The path ids a log row keeps (ADR-523): UUID values only, never a free-text parameter, lower-cased, at most four.
 * The query string is never read (it can carry a search for a name or a phone number).
 */
export function idsOf(params: unknown): Record<string, string> {
  const ids: Record<string, string> = {};
  const entries = Object.entries((params ?? {}) as Record<string, unknown>);
  for (const [name, value] of entries) {
    if (Object.keys(ids).length === MAX_IDS) {
      break;
    }
    if (!IN_COLUMNS.has(name) && typeof value === "string" && UUID.test(value)) {
      ids[name] = value.toLowerCase();
    }
  }
  return ids;
}

/**
 * A view's read, run by the organizer hook once the request is allowed (T-712, ADR-523): it is counted against the admin's `support_view` bucket (queued, so a page's parallel
 * reads all answer) and logged by `support_view_log` with the route pattern and path ids, each in its own short
 * transaction before the request turns read-only.
 *
 * @throws HttpError `too_many_attempts` past the limit; `not_found` when the grant ended since the seat was read.
 */
export async function enterView(
  deps: AdminLimitDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  grant: SupportGrant,
): Promise<void> {
  const adminId = request.staff?.account.id ?? "";
  await holdBackAdmin(deps, adminId, reply, SUPPORT_VIEW_LIMIT);
  const route = routeKeyOf("GET", request.routeOptions.url ?? "");
  try {
    await withConnection(deps.pool, (client) =>
      withRequestContext(client, { staffUserId: adminId }, () =>
        client.query("SELECT support_view_log($1, $2, $3::jsonb, $4)", [
          grant.grantId,
          route,
          JSON.stringify(idsOf(request.params)),
          request.id,
        ]),
      ),
    );
  } catch (error) {
    if ((error as { code?: string }).code === "SG404") {
      throw notFound();
    }
    throw error;
  }
}
