import type { Transports } from "@questify/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { endOwnSession, notFound } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import {
  endAdminSession,
  readAdminAccounts,
  readAdminSessions,
  readHealth,
  readNumbers,
} from "#src/console/platform";
import { endStaffAccountSessions } from "#src/console/staff-sessions";
import { holdBack, type DeviceLimit } from "#src/devices/limits";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
const endSession = {
  config: { access: "admin", idempotent: true },
  bodyLimit: 8192,
} as const;

/** 60 health, numbers and admin reads a minute per admin: the pages reread every 30 seconds at most. */
export const CONSOLE_HEALTH_LIMIT = {
  bucket: BUCKETS.consoleHealth,
  max: 60,
  windowSeconds: 60,
} as const satisfies DeviceLimit;
export const CONSOLE_ADMINS_LIMIT = {
  bucket: BUCKETS.consoleAdmins,
  max: 60,
  windowSeconds: 60,
} as const satisfies DeviceLimit;
/** 30 forced sign-outs an hour per admin. */
export const CONSOLE_SESSION_END_LIMIT = {
  bucket: BUCKETS.consoleSessionEnd,
  max: 30,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;

const accountParams = z.object({ staffUserId: z.uuid() });
const sessionParams = z.object({ sessionId: z.uuid() });
const reasonBody = z.strictObject({ reason: z.string().max(1200) });

export type ConsolePlatformDeps = Readonly<{
  pool: Pool;
  keys: Pick<AuthKeys, "userKey">;
  /** What this server has set up (yes or no), for the health view. */
  transports: Transports;
}>;

/** The admin and the session of a request that passed the console hook (activation/routes.ts). */
export function callerOf(request: FastifyRequest): { id: string; sessionId: string } {
  const staff = request.staff;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (staff === undefined) {
    throw notFound();
  }
  return { id: staff.account.id, sessionId: staff.sessionId };
}

export async function throttled(
  deps: Pick<ConsolePlatformDeps, "pool" | "keys">,
  request: FastifyRequest,
  reply: FastifyReply,
  limit: DeviceLimit,
): Promise<{ id: string; sessionId: string }> {
  const caller = callerOf(request);
  // The key is per bucket, and an admin's calls on one bucket queue for its lock: a page opening several tabs at once
  // reads them all instead of refusing the ones that lost the race.
  const key = deps.keys.userKey(`${limit.bucket}:${caller.id}`);
  await holdBack(deps.pool, [{ limit, key }], true, reply, true);
  return caller;
}

/**
 * The console's platform pages (T-709): health (FR-1783), numbers (FR-1419) and the admin accounts with their sessions
 * and the forced sign-out (FR-1785), and the end of every session of one staff account (FR-141, T-810c). Registered inside the console scope, whose hook answers 404 to anyone but an
 * active platform admin; every door re-reads the admin in the database. Rights are not changed here: an admin is made
 * or removed only by `staff-cli` (ADR-405).
 */
export function registerConsolePlatformRoutes(
  scope: FastifyInstance,
  deps: ConsolePlatformDeps,
): void {
  scope.get("/health", read, async (request, reply) => {
    const caller = await throttled(deps, request, reply, CONSOLE_HEALTH_LIMIT);
    return readHealth(deps.pool, caller, deps.transports);
  });

  scope.get("/numbers", read, async (request, reply) => {
    const caller = await throttled(deps, request, reply, CONSOLE_HEALTH_LIMIT);
    return readNumbers(deps.pool, caller);
  });

  scope.get("/admins", read, async (request, reply) => {
    const caller = await throttled(deps, request, reply, CONSOLE_ADMINS_LIMIT);
    return { admins: await readAdminAccounts(deps.pool, caller, request.id) };
  });

  scope.get("/admins/:staffUserId/sessions", read, async (request, reply) => {
    const { staffUserId } = parse(accountParams, request.params);
    const caller = await throttled(deps, request, reply, CONSOLE_ADMINS_LIMIT);
    return {
      sessions: await readAdminSessions(deps.pool, caller, {
        staffUserId,
        currentSessionId: caller.sessionId,
        requestId: request.id,
      }),
    };
  });

  scope.post("/sessions/:sessionId/end", endSession, async (request, reply) => {
    const { sessionId } = parse(sessionParams, request.params);
    const { reason } = parse(reasonBody, request.body);
    if (sessionId === callerOf(request).sessionId) {
      throw endOwnSession();
    }
    const caller = await throttled(deps, request, reply, CONSOLE_SESSION_END_LIMIT);
    await endAdminSession(deps.pool, caller, { sessionId, reason, requestId: request.id });
    return reply.code(204).send();
  });

  scope.post("/staff/:staffUserId/end-sessions", endSession, async (request, reply) => {
    const { staffUserId } = parse(accountParams, request.params);
    const { reason } = parse(reasonBody, request.body);
    if (staffUserId === callerOf(request).id) {
      throw endOwnSession();
    }
    const caller = await throttled(deps, request, reply, CONSOLE_SESSION_END_LIMIT);
    const ended = await endStaffAccountSessions(deps.pool, caller, {
      staffUserId,
      reason,
      requestId: request.id,
    });
    return { ended };
  });
}
