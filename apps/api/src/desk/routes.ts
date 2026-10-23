import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  abilityOff,
  deskClosed,
  enrollmentInactive,
  handoverMode,
  heldAtDesk,
  notFound,
  notOperator,
  notReady,
  offerGone,
  pausedAtDesk,
  redeemPaused,
  reservationEnded,
  selfHandover,
  tooManyAttempts,
  unauthenticated,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import {
  acceptHandover,
  cancelAtDesk,
  declineHandover,
  findAtDesk,
  handOver,
  lookUp,
  myDeskItems,
  offerState,
  operatorDesk,
  startCollect,
  type DeskDeps,
  type DeskDone,
  type DeskRefusal,
  type Found,
} from "#src/desk/desk";
import { normalizeSaudiMobile } from "#src/players/phone";

const player = { config: { access: "player" }, bodyLimit: 1024 } as const;
const playerIdempotent = { ...player, config: { ...player.config, idempotent: true } } as const;

const eventParams = z.object({ eventId: z.uuid() });
const redemptionParams = z.object({ redemptionId: z.uuid() });
const lookupBody = z.strictObject({ eventId: z.uuid(), code: z.string().min(1).max(512) });
const findBody = z.strictObject({ query: z.string().trim().min(1).max(40) });

/** What the desk is told of a player found by My QR or by name: never a status that would name a ban. */
const foundAnswer = (found: Found) => ({
  result: "found",
  player: found.player,
  active: found.active,
  hold: found.hold,
  items: found.items,
});

const playerIdOf = (request: { player?: { id: string } | undefined }): string => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) {
    throw unauthenticated();
  }
  return request.player.id;
};

/** One HTTP answer per refusal (API.md, the prize desk). */
function refuse(result: DeskRefusal): never {
  switch (result.kind) {
    case "not_found":
    case "not_in_event":
      throw notFound();
    case "not_operator":
      throw notOperator();
    case "ability_off":
      throw abilityOff();
    case "reservation_ended":
      throw reservationEnded({ status: result.status });
    case "enrollment_inactive":
      throw enrollmentInactive({ reason: result.reason });
    case "self_handover":
      throw selfHandover();
    case "handover_mode":
      throw handoverMode();
    case "desk_closed":
      throw deskClosed();
    case "offer_gone":
      throw offerGone();
    case "not_ready":
      throw notReady();
    case "held":
      throw result.hold === "paused" ? pausedAtDesk() : heldAtDesk();
    case "redeem_paused":
      throw redeemPaused();
    // Stryker disable next-line ConditionalExpression: only the lookup raises it, and the lookup answers it as a result
    case "old_code":
      throw notFound();
  }
}

const valueOf = <T>(result: DeskDone<T>): T =>
  result.kind === "done" ? result.value : refuse(result);

/**
 * The prize desk (T-206): the operator's header, My QR lookup, Handed over / Hand over, the poll while an offer waits
 * and Cancel; the player's Collect, Accept, Not now and what My QR shows. No route here pays points or moves the
 * ranking (FR-926).
 */
export function registerDeskRoutes(app: FastifyInstance, deps: DeskDeps): void {
  app.get("/v1/operator/events/:eventId/desk", player, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return { desk: valueOf(await operatorDesk(deps, playerIdOf(request), eventId)) };
  });

  // A bad or earlier code is a result the desk shows, not an error; a removed operator gets 403.
  app.post("/v1/operator/desk/lookup", player, async (request) => {
    const body = parse(lookupBody, request.body);
    const result = await lookUp(
      deps,
      { operatorId: playerIdOf(request), eventId: body.eventId, code: body.code },
      callerOf(request),
    );
    switch (result.kind) {
      case "done": {
        const found = result.value;
        return found.kind === "invalid_code"
          ? { result: "refused", reason: "invalid_code" }
          : foundAnswer(found);
      }
      case "old_code":
        return { result: "refused", reason: "old_code" };
      case "not_in_event":
        return { result: "refused", reason: "not_in_event" };
      case "self_handover":
        return { result: "refused", reason: "self_scan" };
      case "ability_off":
        return { result: "refused", reason: "ability_off" };
      default:
        return refuse(result);
    }
  });

  // FR-1848: by exact username or Saudi mobile when My QR will not scan. Nobody found is a result, not an error.
  app.post("/v1/operator/events/:eventId/desk/find", player, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const { query } = parse(findBody, request.body);
    const phone = normalizeSaudiMobile(query) ?? null;
    const result = await findAtDesk(deps, {
      operatorId: playerIdOf(request),
      eventId,
      username: phone === null ? query.replace(/^@/, "") : null,
      phone,
    });
    if (result.kind === "throttled") {
      reply.header("retry-after", String(result.retryAfterSeconds));
      throw tooManyAttempts();
    }
    const found = valueOf(result);
    return found === null ? { result: "none" } : foundAnswer(found);
  });

  app.post(
    "/v1/operator/redemptions/:redemptionId/hand-over",
    playerIdempotent,
    async (request) => {
      const { redemptionId } = parse(redemptionParams, request.params);
      return valueOf(
        await handOver(deps, { operatorId: playerIdOf(request), redemptionId }, callerOf(request)),
      );
    },
  );

  app.get("/v1/operator/redemptions/:redemptionId", player, async (request, reply) => {
    const { redemptionId } = parse(redemptionParams, request.params);
    reply.header("cache-control", "no-store");
    return valueOf(await offerState(deps, { operatorId: playerIdOf(request), redemptionId }));
  });

  app.post("/v1/operator/redemptions/:redemptionId/cancel", playerIdempotent, async (request) => {
    const { redemptionId } = parse(redemptionParams, request.params);
    return valueOf(
      await cancelAtDesk(
        deps,
        { operatorId: playerIdOf(request), redemptionId },
        callerOf(request),
      ),
    );
  });

  app.post("/v1/redemptions/:redemptionId/collect", player, async (request) => {
    const { redemptionId } = parse(redemptionParams, request.params);
    return valueOf(await startCollect(deps, { playerId: playerIdOf(request), redemptionId }));
  });

  // A flag or ban hold tells the player nothing (ADR-154): it reads as no live offer. A pause is theirs to know.
  app.post("/v1/redemptions/:redemptionId/accept", playerIdempotent, async (request) => {
    const { redemptionId } = parse(redemptionParams, request.params);
    const result = await acceptHandover(deps, { playerId: playerIdOf(request), redemptionId });
    if (result.kind === "held" && result.hold === "held") {
      throw offerGone();
    }
    return valueOf(result);
  });

  app.post("/v1/redemptions/:redemptionId/decline", player, async (request, reply) => {
    const { redemptionId } = parse(redemptionParams, request.params);
    valueOf(await declineHandover(deps, { playerId: playerIdOf(request), redemptionId }));
    return reply.code(204).send();
  });

  app.get("/v1/me/desk-items", player, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return myDeskItems(deps, playerIdOf(request));
  });
}
