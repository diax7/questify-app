import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import {
  cancelOwnerEmailChange,
  IDENTITY_CHECKS,
  resendOwnerEmailCode,
  startOwnerEmailChange,
  type OwnerEmailDeps,
} from "#src/console/owner-email";
import { throttled } from "#src/console/throttle";
import type { DeviceLimit } from "#src/devices/limits";

const change = { config: { access: "admin", idempotent: true }, bodyLimit: 4096 } as const;

/** 10 owner email changes started an hour per admin (ADR-491). */
export const CONSOLE_OWNER_EMAIL_LIMIT = {
  bucket: BUCKETS.consoleOwnerEmail,
  max: 10,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;
/** 30 resends and cancels an hour per admin. */
export const CONSOLE_OWNER_EMAIL_CHANGE_LIMIT = {
  bucket: BUCKETS.consoleOwnerEmailChange,
  max: 30,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;

const organizerParams = z.object({ organizerId: z.uuid() });
const changeParams = z.object({ changeId: z.uuid() });
const lang = z.enum(["ar", "en"]).default("ar");
const startBody = z.strictObject({
  newEmail: z.string().trim().min(3).max(254),
  identityCheck: z.enum(IDENTITY_CHECKS),
  reason: z.string().max(1200),
  lang,
});
const resendBody = z.strictObject({ lang }).optional();
const emptyBody = z.strictObject({}).optional();

/**
 * The console's owner email change (T-701b, FR-1784, ADR-490..492): start from the organizer page, resend the code,
 * cancel. Registered inside the console scope (404 to anyone but an active platform admin); every door re-reads the
 * admin and writes the audit entry with ids only. The owner confirms on the public page (auth/routes.ts).
 */
export function registerConsoleOwnerEmailRoutes(
  scope: FastifyInstance,
  deps: OwnerEmailDeps,
): void {
  scope.post("/organizers/:organizerId/owner-email", change, async (request, reply) => {
    const { organizerId } = parse(organizerParams, request.params);
    const body = parse(startBody, request.body);
    const who = await throttled(deps, request, reply, CONSOLE_OWNER_EMAIL_LIMIT);
    const started = await startOwnerEmailChange(deps, who, { organizerId, ...body }, request.id);
    return reply.code(201).send(started);
  });

  scope.post("/owner-email-changes/:changeId/resend", change, async (request, reply) => {
    const { changeId } = parse(changeParams, request.params);
    const body = parse(resendBody, request.body);
    const who = await throttled(deps, request, reply, CONSOLE_OWNER_EMAIL_CHANGE_LIMIT);
    await resendOwnerEmailCode(deps, who, { changeId, lang: body?.lang ?? "ar" }, request.id);
    return reply.code(204).send();
  });

  scope.post("/owner-email-changes/:changeId/cancel", change, async (request, reply) => {
    const { changeId } = parse(changeParams, request.params);
    parse(emptyBody, request.body);
    const who = await throttled(deps, request, reply, CONSOLE_OWNER_EMAIL_CHANGE_LIMIT);
    await cancelOwnerEmailChange(deps, who, changeId, request.id);
    return reply.code(204).send();
  });
}
