import { createHash } from "node:crypto";
import { TICKET_KINDS, TICKET_TEXT_MAX } from "@questify/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { holdBack, type DeviceLimit } from "#src/devices/limits";
import { HttpError } from "#src/http-error";
import {
  adminAnswer,
  adminReturn,
  consoleTicket,
  consoleTicketCounts,
  consoleTickets,
} from "#src/tickets/console";
import { keyOf, logAnswer, valueOf } from "#src/tickets/routes";
import type { TicketDeps } from "#src/tickets/tickets";

const BODY_LIMIT = 8192;
const admin = { config: { access: "admin" }, bodyLimit: BODY_LIMIT } as const;
const adminIdempotent = { ...admin, config: { ...admin.config, idempotent: true } } as const;

const ID = /^[1-9][0-9]{0,17}$/;
const ticketParams = z.object({ ticketId: z.string().regex(ID) });
const listQuery = z.strictObject({
  status: z.enum(["open", "closed"]).default("open"),
  kind: z.enum(TICKET_KINDS).optional(),
  source: z.enum(["direct", "escalated"]).optional(),
  cursor: z.string().regex(ID).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const answerBody = z.strictObject({
  reply: z
    .string()
    .max(TICKET_TEXT_MAX * 4)
    .optional(),
});
const noteBody = z.strictObject({ note: z.string().max(TICKET_TEXT_MAX * 4) });

/** 120 console ticket calls a minute per admin, so a stolen session cannot scrape the queue quickly. */
export const CONSOLE_TICKET_LIMIT = {
  bucket: BUCKETS.consoleTicket,
  max: 120,
  windowSeconds: 60,
} as const satisfies DeviceLimit;

export type ConsoleTicketDeps = TicketDeps & Readonly<{ keys: Pick<AuthKeys, "userKey"> }>;

/** The admin of a request that passed the console hook (activation/routes.ts). */
function adminIdOf(request: FastifyRequest): string {
  const account = request.staff?.account;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (account === undefined) {
    throw notFound();
  }
  return account.id;
}

/** Holds one call against the admin's limit; a refusal is logged by a hash of the admin's id, never the id. */
async function throttle(
  deps: ConsoleTicketDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string> {
  const adminId = adminIdOf(request);
  try {
    await holdBack(
      deps.pool,
      [{ limit: CONSOLE_TICKET_LIMIT, key: deps.keys.userKey(adminId) }],
      true,
      reply,
    );
  } catch (error) {
    if (error instanceof HttpError) {
      request.log.warn({
        event: "console.tickets_throttled",
        adminIdHash: createHash("sha256").update(adminId).digest("hex").slice(0, 16),
      });
    }
    throw error;
  }
  return adminId;
}

/**
 * The console's Tickets page (T-312, FR-1823): Questify's queue, registered inside the console scope, whose hook
 * answers 404 to anyone but an active platform admin and sets `no-store`. The database re-reads the admin in every
 * function and audits every read; an id outside the queue is the same 404 as a missing one.
 */
export function registerConsoleTicketRoutes(scope: FastifyInstance, deps: ConsoleTicketDeps): void {
  scope.get("/tickets", admin, async (request, reply) => {
    const query = parse(listQuery, request.query);
    const adminId = await throttle(deps, request, reply);
    const page = valueOf(
      request,
      reply,
      await consoleTickets(deps, adminId, {
        status: query.status,
        kind: query.kind ?? null,
        source: query.source ?? null,
        cursor: query.cursor ?? null,
        limit: query.limit,
        requestId: request.id,
      }),
    );
    return {
      tickets: page.tickets,
      nextCursor: page.tickets[query.limit - 1]?.id ?? null,
      counts: page.counts,
    };
  });

  scope.get("/tickets/counts", admin, async (request, reply) => {
    const adminId = await throttle(deps, request, reply);
    return { counts: valueOf(request, reply, await consoleTicketCounts(deps, adminId)) };
  });

  scope.get("/tickets/:ticketId", admin, async (request, reply) => {
    const { ticketId } = parse(ticketParams, request.params);
    const adminId = await throttle(deps, request, reply);
    return {
      ticket: valueOf(
        request,
        reply,
        await consoleTicket(deps, adminId, { ticketId, requestId: request.id }),
      ),
    };
  });

  scope.post("/tickets/:ticketId/answer", adminIdempotent, async (request, reply) => {
    const { ticketId } = parse(ticketParams, request.params);
    const body = parse(answerBody, request.body);
    const adminId = await throttle(deps, request, reply);
    const answered = valueOf(
      request,
      reply,
      await adminAnswer(deps, adminId, {
        ticketId,
        reply: body.reply ?? null,
        idempotencyKey: keyOf(request),
        requestId: request.id,
      }),
    );
    return logAnswer(request, answered, "admin");
  });

  scope.post("/tickets/:ticketId/return", adminIdempotent, async (request, reply) => {
    const { ticketId } = parse(ticketParams, request.params);
    const { note } = parse(noteBody, request.body);
    const adminId = await throttle(deps, request, reply);
    const returned = valueOf(
      request,
      reply,
      await adminReturn(deps, adminId, { ticketId, note, requestId: request.id }),
    );
    request.log.info({ event: "ticket.returned", replayed: returned.replayed });
    return returned;
  });
}
