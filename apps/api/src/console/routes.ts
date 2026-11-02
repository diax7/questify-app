import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import {
  closeSupport,
  openSupport,
  reactivate,
  suspend,
  type SuspendTarget,
} from "#src/console/doors";
import { readOrganizer, readOrganizers } from "#src/console/organizers";
import { holdBack, type DeviceLimit } from "#src/devices/limits";
import type { SuspendedSet } from "#src/events/suspended-set";

const BODY_LIMIT = 8192;
const admin = { config: { access: "admin" }, bodyLimit: BODY_LIMIT } as const;
const adminIdempotent = { ...admin, config: { ...admin.config, idempotent: true } } as const;

/** 120 console organizer reads a minute per admin, so a stolen session cannot scrape owner emails quickly. */
export const CONSOLE_ORGANIZER_LIMIT = {
  bucket: BUCKETS.consoleOrganizer,
  max: 120,
  windowSeconds: 60,
} as const satisfies DeviceLimit;
/** 30 suspensions and reactivations an hour per admin. */
export const CONSOLE_SUSPEND_LIMIT = {
  bucket: BUCKETS.consoleSuspend,
  max: 30,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;

const listQuery = z.strictObject({
  q: z.string().trim().min(1).max(254).optional(),
  status: z.enum(["active", "paused"]).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const organizerParams = z.object({ organizerId: z.uuid() });
const eventParams = z.object({ eventId: z.uuid() });
const grantParams = z.object({ grantId: z.uuid() });
const reasonBody = z.strictObject({ reason: z.string().max(1200) });
const emptyBody = z.strictObject({}).optional();
const liftBody = z.strictObject({ reason: z.string().max(1200).optional() }).optional();

export type ConsoleOrganizerDeps = Readonly<{
  pool: Pool;
  keys: Pick<AuthKeys, "userKey">;
  /** Told at once when a suspension changes here; other instances follow within 10 s. */
  suspended: SuspendedSet;
}>;

/** The admin of a request that passed the console hook (activation/routes.ts). */
function adminOf(request: FastifyRequest): { id: string } {
  const account = request.staff?.account;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (account === undefined) {
    throw notFound();
  }
  return { id: account.id };
}

async function throttled(
  deps: ConsoleOrganizerDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  limit: DeviceLimit,
): Promise<{ id: string }> {
  const who = adminOf(request);
  await holdBack(deps.pool, [{ limit, key: deps.keys.userKey(who.id) }], true, reply);
  return who;
}

function registerSuspensionRoutes(scope: FastifyInstance, deps: ConsoleOrganizerDeps): void {
  const targets: ReadonlyArray<
    Readonly<{ path: string; target: (params: unknown) => SuspendTarget }>
  > = [
    {
      path: "/organizers/:organizerId",
      target: (params) => ({ kind: "organizer", id: parse(organizerParams, params).organizerId }),
    },
    {
      path: "/events/:eventId",
      target: (params) => ({ kind: "event", id: parse(eventParams, params).eventId }),
    },
  ];
  for (const { path, target } of targets) {
    scope.post(`${path}/suspend`, adminIdempotent, async (request, reply) => {
      const which = target(request.params);
      const { reason } = parse(reasonBody, request.body);
      const who = await throttled(deps, request, reply, CONSOLE_SUSPEND_LIMIT);
      const suspendedAt = await suspend(deps.pool, who, which, { reason, requestId: request.id });
      deps.suspended.invalidate();
      return { suspendedAt };
    });
    scope.post(`${path}/reactivate`, adminIdempotent, async (request, reply) => {
      const which = target(request.params);
      const reason = parse(liftBody, request.body)?.reason;
      const who = await throttled(deps, request, reply, CONSOLE_SUSPEND_LIMIT);
      await reactivate(deps.pool, who, which, { reason, requestId: request.id });
      deps.suspended.invalidate();
      return reply.code(204).send();
    });
  }
}

/**
 * The console's organizers and events (T-701, FR-1402, FR-1408): the list and one organizer (reads audited with ids
 * only), suspending and reactivating an organizer or an event, and opening or closing 15 minutes of support on one
 * event. Registered inside the console scope, whose hook answers 404 to anyone but an active platform admin; every
 * door re-reads the admin in the database.
 */
export function registerConsoleOrganizerRoutes(
  scope: FastifyInstance,
  deps: ConsoleOrganizerDeps,
): void {
  scope.get("/organizers", admin, async (request, reply) => {
    const query = parse(listQuery, request.query);
    const who = await throttled(deps, request, reply, CONSOLE_ORGANIZER_LIMIT);
    const organizers = await readOrganizers(
      deps.pool,
      who,
      {
        q: query.q ?? null,
        status: query.status ?? null,
        cursor: query.cursor ?? null,
        limit: query.limit,
      },
      request.id,
    );
    return {
      organizers,
      nextCursor: organizers.length === query.limit ? (organizers.at(-1)?.id ?? null) : null,
    };
  });

  scope.get("/organizers/:organizerId", admin, async (request, reply) => {
    const { organizerId } = parse(organizerParams, request.params);
    const who = await throttled(deps, request, reply, CONSOLE_ORGANIZER_LIMIT);
    const detail = await readOrganizer(deps.pool, who, organizerId, request.id);
    if (detail === undefined) {
      throw notFound();
    }
    return detail;
  });

  registerSuspensionRoutes(scope, deps);

  scope.post("/events/:eventId/support", adminIdempotent, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const { reason } = parse(reasonBody, request.body);
    const grant = await openSupport(deps.pool, adminOf(request), {
      eventId,
      reason,
      requestId: request.id,
    });
    return reply.code(201).send({ grant });
  });

  scope.post("/support/:grantId/close", adminIdempotent, async (request, reply) => {
    const { grantId } = parse(grantParams, request.params);
    parse(emptyBody, request.body);
    await closeSupport(deps.pool, adminOf(request), grantId, request.id);
    return reply.code(204).send();
  });
}
