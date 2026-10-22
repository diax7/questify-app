import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  abilityOff,
  deskClosed,
  enrollmentInactive,
  handoverMode,
  notFound,
  notOperator,
  notReady,
  offerGone,
  reservationEnded,
  selfHandover,
  unauthenticated,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import {
  acceptHandover,
  cancelAtDesk,
  declineHandover,
  handOver,
  lookUp,
  myDeskItems,
  offerState,
  operatorDesk,
  startCollect,
  type DeskDeps,
  type DeskDone,
  type DeskRefusal,
} from "#src/desk/desk";

const player = { config: { access: "player" }, bodyLimit: 1024 } as const;
const playerIdempotent = { ...player, config: { ...player.config, idempotent: true } } as const;

const eventParams = z.object({ eventId: z.uuid() });
const redemptionParams = z.object({ redemptionId: z.uuid() });
const lookupBody = z.strictObject({ eventId: z.uuid(), code: z.string().min(1).max(512) });

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
          : {
              result: "found",
              player: found.player,
              enrollment: found.enrollment,
              items: found.items,
            };
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

  app.post("/v1/redemptions/:redemptionId/accept", playerIdempotent, async (request) => {
    const { redemptionId } = parse(redemptionParams, request.params);
    return valueOf(await acceptHandover(deps, { playerId: playerIdOf(request), redemptionId }));
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
