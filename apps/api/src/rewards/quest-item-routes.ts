import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  deskNeeded,
  eventArchived,
  invalidRequest,
  itemInUse,
  limitReached,
  notFound,
  stockBelowReserved,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import {
  QUEST_ITEM_STOCK_MAX,
  createItem,
  itemMisses,
  listItems,
  removeItem,
  updateItem,
  type QuestItemDeps,
  type QuestItemDone,
  type QuestItemRefusal,
} from "#src/rewards/quest-items";

const member = { config: { access: "member" }, bodyLimit: 16 * 1024 } as const;
const creating = { ...member, config: { ...member.config, idempotent: true } } as const;

const eventParams = z.object({ eventId: z.uuid() });
const itemParams = z.object({ eventId: z.uuid(), itemId: z.uuid() });
const text = (max: number) =>
  z.strictObject({ ar: z.string().max(max).nullish(), en: z.string().max(max).nullish() });
const stock = z.number().int().min(0).max(QUEST_ITEM_STOCK_MAX);
const itemPatch = z.strictObject({
  name: text(120).optional(),
  description: text(2000).optional(),
  stockTotal: stock.optional(),
});
const itemBody = z.strictObject({
  name: text(120),
  description: text(2000).optional(),
  stockTotal: stock,
});

function refuse(result: QuestItemRefusal): never {
  switch (result.kind) {
    case "not_found":
      throw notFound();
    case "event_archived":
      throw eventArchived();
    case "invalid":
      throw invalidRequest({ field: result.field });
    case "limit_reached":
      throw limitReached({ limit: result.limit });
    case "desk_needed":
      throw deskNeeded();
    case "item_in_use":
      throw itemInUse();
    case "stock_below_reserved":
      throw stockBelowReserved({ unitsOut: result.unitsOut });
  }
}

const valueOf = <T>(result: QuestItemDone<T>): T =>
  result.kind === "done" ? result.value : refuse(result);

/**
 * Quest items in the organizer scope (T-304d, FR-522, FR-1617): `GET|POST …/events/:eventId/quest-items`,
 * `PATCH|DELETE …/quest-items/:itemId` and `GET …/quest-items/:itemId/misses` (owners and editors). The database checks
 * every rule again.
 */
export function registerQuestItemRoutes(scope: FastifyInstance, deps: QuestItemDeps): void {
  scope.get("/events/:eventId/quest-items", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return { items: valueOf(await listItems(deps, organizerContextOf(request), eventId)) };
  });

  scope.post("/events/:eventId/quest-items", creating, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(itemBody, request.body);
    const item = valueOf(
      await createItem(deps, organizerContextOf(request), eventId, body, callerOf(request)),
    );
    return reply.code(201).send({ item });
  });

  scope.patch("/events/:eventId/quest-items/:itemId", member, async (request) => {
    const { eventId, itemId } = parse(itemParams, request.params);
    const body = parse(itemPatch, request.body);
    const item = valueOf(
      await updateItem(
        deps,
        organizerContextOf(request),
        { eventId, id: itemId },
        body,
        callerOf(request),
      ),
    );
    return { item };
  });

  scope.delete("/events/:eventId/quest-items/:itemId", member, async (request, reply) => {
    const { eventId, itemId } = parse(itemParams, request.params);
    valueOf(
      await removeItem(
        deps,
        organizerContextOf(request),
        { eventId, id: itemId },
        callerOf(request),
      ),
    );
    return reply.code(204).send();
  });

  scope.get("/events/:eventId/quest-items/:itemId/misses", member, async (request) => {
    const { eventId, itemId } = parse(itemParams, request.params);
    return {
      misses: valueOf(await itemMisses(deps, organizerContextOf(request), { eventId, id: itemId })),
    };
  });
}
