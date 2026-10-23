import { decodeCursor, encodeCursor, parseLimit } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { caseClosed, invalidRequest, noRemoval, notFound, ownerOnly } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  flagDetail,
  listFlags,
  resolveFlag,
  setFlagHold,
  setRedeemPause,
  type FlagDone,
  type FlagRefusal,
  type FlagsDeps,
  type SwitchOutcome,
} from "#src/flags/flags";
import { organizerContextOf } from "#src/organizers/context";

const member = { config: { access: "member" }, bodyLimit: 2048 } as const;
const owner = { config: { access: "owner" }, bodyLimit: 1024 } as const;

const ID = /^[1-9][0-9]{0,17}$/;
const eventParams = z.object({ eventId: z.uuid() });
const flagParams = z.object({ eventId: z.uuid(), flagId: z.string().regex(ID) });
const playerParams = z.object({ eventId: z.uuid(), enrollmentId: z.uuid() });
const listQuery = z.strictObject({
  status: z.enum(["open", "closed"]).default("open"),
  cursor: z.string().max(200).optional(),
  limit: z.string().optional(),
});
const resolveBody = z.strictObject({
  resolution: z.enum(["cleared", "points_removed"]),
  note: z.string().max(1000).nullable().optional(),
});
const pauseBody = z.strictObject({ paused: z.boolean() });
const holdBody = z.strictObject({ on: z.boolean() });

function refuse(result: FlagRefusal): never {
  switch (result.kind) {
    case "not_found":
      throw notFound();
    case "resolved":
      throw caseClosed();
    case "no_removal":
      throw noRemoval();
    case "invalid":
      throw invalidRequest();
  }
}

const valueOf = <T>(result: FlagDone<T>): T =>
  result.kind === "done" ? result.value : refuse(result);

/** An owner-only switch's outcome: an editor reaching it is stopped by the scope's hook first. */
function switched(outcome: SwitchOutcome): void {
  if (outcome === "not_found") {
    throw notFound();
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the scope's hook refuses an editor first
  if (outcome === "not_owner") {
    throw ownerOnly();
  }
}

function beforeOf(cursor: string | undefined): string | null {
  if (cursor === undefined) {
    return null;
  }
  try {
    return z.string().regex(ID).parse(decodeCursor(cursor)["id"]);
  } catch {
    throw invalidRequest();
  }
}

/**
 * The flagged-activity page (FR-335, FR-336, T-209) inside the organizer scope: owners and editors read cases, clear
 * them or close them after removing points; the owner pauses a player's redemptions and switches the desk's flag hold.
 * Bans stay on the players' ban route, which also closes the player's open cases. The database checks again.
 */
export function registerFlagRoutes(scope: FastifyInstance, deps: FlagsDeps): void {
  scope.get("/events/:eventId/flags", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const query = parse(listQuery, request.query);
    let limit: number;
    try {
      limit = parseLimit(query.limit);
    } catch {
      throw invalidRequest();
    }
    const done = valueOf(
      await listFlags(deps, organizerContextOf(request), {
        eventId,
        open: query.status === "open",
        beforeId: beforeOf(query.cursor),
        limit,
      }),
    );
    const last = done.flags.at(-1);
    return {
      hold: done.hold,
      flags: done.flags,
      nextCursor:
        done.flags.length === limit && last !== undefined ? encodeCursor({ id: last.id }) : null,
    };
  });

  scope.get("/events/:eventId/flags/:flagId", member, async (request) => {
    const { eventId, flagId } = parse(flagParams, request.params);
    const flag = valueOf(await flagDetail(deps, organizerContextOf(request), { eventId, flagId }));
    if (flag === null) {
      throw notFound();
    }
    return { flag };
  });

  scope.post("/events/:eventId/flags/:flagId/resolve", member, async (request) => {
    const { eventId, flagId } = parse(flagParams, request.params);
    const body = parse(resolveBody, request.body);
    return valueOf(
      await resolveFlag(deps, organizerContextOf(request), {
        eventId,
        flagId,
        resolution: body.resolution,
        note: body.note ?? null,
        requestId: request.id,
      }),
    );
  });

  scope.put("/events/:eventId/players/:enrollmentId/redeem-pause", owner, async (request) => {
    const { eventId, enrollmentId } = parse(playerParams, request.params);
    const { paused } = parse(pauseBody, request.body);
    switched(
      valueOf(
        await setRedeemPause(deps, organizerContextOf(request), {
          eventId,
          enrollmentId,
          paused,
          requestId: request.id,
        }),
      ),
    );
    return { paused };
  });

  scope.put("/events/:eventId/flag-hold", owner, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { on } = parse(holdBody, request.body);
    switched(
      valueOf(
        await setFlagHold(deps, organizerContextOf(request), {
          eventId,
          on,
          requestId: request.id,
        }),
      ),
    );
    return { on };
  });
}
