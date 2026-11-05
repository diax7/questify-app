import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { notFound } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { holdBack, type DeviceLimit } from "#src/devices/limits";

export type AdminLimitDeps = Readonly<{ pool: Pool; keys: Pick<AuthKeys, "userKey"> }>;

/** The admin and the session of a request that passed the console hook (activation/routes.ts). */
export function callerOf(request: FastifyRequest): { id: string; sessionId: string } {
  const staff = request.staff;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (staff === undefined) {
    throw notFound();
  }
  return { id: staff.account.id, sessionId: staff.sessionId };
}

/**
 * Counts one call against an admin's bucket. The key is per bucket, and an admin's calls on one bucket queue for its
 * lock: a page opening several tabs at once reads them all instead of refusing the ones that lost the race.
 *
 * @throws HttpError `too_many_attempts` past the limit, with `Retry-After` set on the reply.
 */
export async function holdBackAdmin(
  deps: AdminLimitDeps,
  adminId: string,
  reply: FastifyReply,
  limit: DeviceLimit,
): Promise<void> {
  await holdBack(
    deps.pool,
    [{ limit, key: deps.keys.userKey(`${limit.bucket}:${adminId}`) }],
    true,
    reply,
    true,
  );
}

/** The console's rate limit: counts the request's admin against `limit` and answers who that admin is. */
export async function throttled(
  deps: AdminLimitDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  limit: DeviceLimit,
): Promise<{ id: string; sessionId: string }> {
  const caller = callerOf(request);
  await holdBackAdmin(deps, caller.id, reply, limit);
  return caller;
}
