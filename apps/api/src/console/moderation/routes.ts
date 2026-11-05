import { HOLD_KINDS, HOLD_REASONS, REPORT_KINDS, REPORT_OUTCOMES } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import {
  readCounts,
  readFlags,
  readQueue,
  readTarget,
  republish,
  resolveReports,
  unpublish,
} from "#src/console/moderation/doors";
import type { ConsolePlayerDeps } from "#src/console/players/routes";
import { throttled } from "#src/console/throttle";
import type { DeviceLimit } from "#src/devices/limits";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
const change = { config: { access: "admin", idempotent: true }, bodyLimit: 4096 } as const;

/** 120 queue reads a minute per admin. */
export const CONSOLE_REPORTS_READ_LIMIT = {
  bucket: BUCKETS.consoleReports,
  max: 120,
  windowSeconds: 60,
} as const satisfies DeviceLimit;
/** 120 queue actions an hour per admin: unpublish, republish and closing reports, together. */
export const CONSOLE_MODERATION_LIMIT = {
  bucket: BUCKETS.consoleModeration,
  max: 120,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;
/** 60 flag-list reads a minute per admin. */
export const CONSOLE_FLAGS_LIMIT = {
  bucket: BUCKETS.consoleFlags,
  max: 60,
  windowSeconds: 60,
} as const satisfies DeviceLimit;

const queueQuery = z.strictObject({ kind: z.enum(REPORT_KINDS).optional() });
const targetParams = z.object({ kind: z.enum(REPORT_KINDS), targetId: z.uuid() });
const resolveBody = z.strictObject({ outcome: z.enum(REPORT_OUTCOMES) });
const holdTarget = { kind: z.enum(HOLD_KINDS), targetId: z.uuid(), note: z.string().max(1200) };
const unpublishBody = z.strictObject({ ...holdTarget, reasonCode: z.enum(HOLD_REASONS) });
const republishBody = z.strictObject(holdTarget);

/**
 * Questify's moderation tools (T-705b, FR-1404, FR-1414): the reports queue grouped by target, one target's reports,
 * closing them with the action taken, unpublishing and republishing a quest, a reward or an announcement, and the open
 * anti-cheat flags of every event. Registered inside the console scope, whose hook answers 404 to anyone but an active
 * platform admin; every door re-reads the admin in the database and writes the audit entry with ids only. Changing a
 * username and banning are T-704's and T-705's doors on the player's record; suspending an event is T-701's.
 */
export function registerConsoleModerationRoutes(
  scope: FastifyInstance,
  deps: ConsolePlayerDeps,
): void {
  scope.get("/reports", read, async (request, reply) => {
    const query = parse(queueQuery, request.query);
    const who = await throttled(deps, request, reply, CONSOLE_REPORTS_READ_LIMIT);
    return readQueue(deps.pool, who, query.kind ?? null, request.id);
  });

  scope.get("/reports/counts", read, async (request, reply) => {
    const who = await throttled(deps, request, reply, CONSOLE_REPORTS_READ_LIMIT);
    return readCounts(deps.pool, who);
  });

  scope.get("/reports/:kind/:targetId", read, async (request, reply) => {
    const target = parse(targetParams, request.params);
    const who = await throttled(deps, request, reply, CONSOLE_REPORTS_READ_LIMIT);
    return readTarget(deps.pool, who, target, request.id);
  });

  scope.post("/reports/:kind/:targetId/resolve", change, async (request, reply) => {
    const target = parse(targetParams, request.params);
    const { outcome } = parse(resolveBody, request.body);
    const who = await throttled(deps, request, reply, CONSOLE_MODERATION_LIMIT);
    const closed = await resolveReports(deps.pool, who, { ...target, outcome }, request.id);
    return { closed };
  });

  scope.post("/holds", change, async (request, reply) => {
    const body = parse(unpublishBody, request.body);
    const who = await throttled(deps, request, reply, CONSOLE_MODERATION_LIMIT);
    const made = await unpublish(deps.pool, who, body, request.id);
    return reply.code(made.outcome === "unpublished" ? 201 : 200).send(made);
  });

  scope.post("/holds/release", change, async (request, reply) => {
    const body = parse(republishBody, request.body);
    const who = await throttled(deps, request, reply, CONSOLE_MODERATION_LIMIT);
    await republish(deps.pool, who, body, request.id);
    return reply.code(204).send();
  });

  scope.get("/flags", read, async (request, reply) => {
    const who = await throttled(deps, request, reply, CONSOLE_FLAGS_LIMIT);
    return readFlags(deps.pool, who, request.id);
  });
}
