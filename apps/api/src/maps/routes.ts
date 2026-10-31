import { mapBodySchema, mapOrderSchema, mapPinBodySchema, type TeamMap } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { memberQuests, type HomeDeps } from "#src/home/home";
import { requireEventFeature } from "#src/settings/feature-guard";
import { memberMapsOf, type DoorMaps, type PinQuest } from "#src/maps/member";
import { mapCall, mapError, type MapDeps } from "#src/maps/store";
import { organizerContextOf } from "#src/organizers/context";

const eventParams = z.object({ eventId: z.uuid() });
const mapParams = eventParams.extend({ mapId: z.uuid() });
const pinParams = mapParams.extend({ pinId: z.uuid() });

const member = { config: { access: "member" } } as const;
/** A write by the team: the caller's access to the event is asked again before a stored answer is replayed. */
const writing = (deps: MapDeps) =>
  ({
    config: { access: "member", idempotent: true },
    preValidation: async (request: FastifyRequest) => {
      const { eventId } = parse(eventParams, request.params);
      await mapCall(deps, organizerContextOf(request), "SELECT map_authorize($1)", [eventId]);
    },
  }) as const;

/** The body checked by `schema`, or the first failing field in the words the dashboard maps to a message. */
function bodyOf<Schema extends z.ZodType>(schema: Schema, body: unknown): z.output<Schema> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path[0];
  throw mapError(422, "invalid_map", { issue: typeof field === "string" ? field : "map" });
}

/** The dashboard's side (T-506): the maps with their pins, add, rename, order, delete, and the pins. */
export function registerMapTeamRoutes(scope: FastifyInstance, deps: MapDeps): void {
  const run = <Row extends object>(request: FastifyRequest, sql: string, values: unknown[]) =>
    mapCall<Row>(deps, organizerContextOf(request), sql, values);
  scope.get("/events/:eventId/maps", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    const result = await run<{ maps: TeamMap[] }>(request, "SELECT map_list($1) AS maps", [
      eventId,
    ]);
    return { maps: result.maps };
  });
  scope.post("/events/:eventId/maps", writing(deps), async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const draft = JSON.stringify(bodyOf(mapBodySchema, request.body));
    const result = await run<{ map: TeamMap }>(
      request,
      "SELECT map_save($1, $2::jsonb, NULL, $3) AS map",
      [eventId, draft, request.id],
    );
    return reply.code(201).send(result.map);
  });
  scope.put("/events/:eventId/maps/order", writing(deps), async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { ids } = bodyOf(mapOrderSchema, request.body);
    const result = await run<{ maps: TeamMap[] }>(
      request,
      "SELECT map_order($1, $2::uuid[], $3) AS maps",
      [eventId, ids, request.id],
    );
    return { maps: result.maps };
  });
  scope.put("/events/:eventId/maps/:mapId", writing(deps), async (request) => {
    const { eventId, mapId } = parse(mapParams, request.params);
    const draft = JSON.stringify(bodyOf(mapBodySchema, request.body));
    const result = await run<{ map: TeamMap }>(
      request,
      "SELECT map_save($1, $2::jsonb, $3, $4) AS map",
      [eventId, draft, mapId, request.id],
    );
    return result.map;
  });
  scope.delete("/events/:eventId/maps/:mapId", writing(deps), async (request) => {
    const { eventId, mapId } = parse(mapParams, request.params);
    const result = await run<{ lost: number }>(request, "SELECT map_delete($1, $2, $3) AS lost", [
      eventId,
      mapId,
      request.id,
    ]);
    return { pinsLost: result.lost };
  });
  scope.post("/events/:eventId/maps/:mapId/pins", writing(deps), async (request, reply) => {
    const { eventId, mapId } = parse(mapParams, request.params);
    const draft = JSON.stringify(bodyOf(mapPinBodySchema, request.body));
    const result = await run<{ map: TeamMap }>(
      request,
      "SELECT map_pin_save($1, $2, $3::jsonb, NULL, $4) AS map",
      [eventId, mapId, draft, request.id],
    );
    return reply.code(201).send(result.map);
  });
  scope.put("/events/:eventId/maps/:mapId/pins/:pinId", writing(deps), async (request) => {
    const { eventId, mapId, pinId } = parse(pinParams, request.params);
    const draft = JSON.stringify(bodyOf(mapPinBodySchema, request.body));
    const result = await run<{ map: TeamMap }>(
      request,
      "SELECT map_pin_save($1, $2, $3::jsonb, $4, $5) AS map",
      [eventId, mapId, draft, pinId, request.id],
    );
    return result.map;
  });
  scope.delete("/events/:eventId/maps/:mapId/pins/:pinId", writing(deps), async (request) => {
    const { eventId, mapId, pinId } = parse(pinParams, request.params);
    const result = await run<{ map: TeamMap }>(
      request,
      "SELECT map_pin_delete($1, $2, $3, $4) AS map",
      [eventId, mapId, pinId, request.id],
    );
    return result.map;
  });
}

const player = { config: { access: "player" } } as const;

/** What the pins' quests show: the quests the player lists, by id, with the state the Quests tab shows. */
async function listedQuests(
  deps: HomeDeps,
  playerId: string,
  eventId: string,
): Promise<ReadonlyMap<string, PinQuest>> {
  const view = await memberQuests(deps, playerId, eventId);
  if (view.kind !== "quests") return new Map();
  const entries = view.categories.flatMap((category) =>
    category.quests.map((quest): readonly [string, PinQuest] => [
      quest.id,
      { id: quest.id, title: quest.title, points: quest.points, state: quest.state },
    ]),
  );
  return new Map(entries);
}

/** The player's side (T-506): the event's maps with their own view of each quest pin, and where they last scanned. */
export function registerMemberMapRoutes(app: FastifyInstance, deps: HomeDeps): void {
  app.get("/v1/events/:eventId/maps", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    if (request.player === undefined) throw unauthenticated();
    const playerId = request.player.id;
    await requireEventFeature(deps.settings, eventId, playerId, "maps");
    const door = await mapCall<{ answer: DoorMaps }>(
      deps,
      { playerId },
      "SELECT member_maps($1) AS answer",
      [eventId],
    );
    const pinned = door.answer.maps.some((map) => map.pins.some((pin) => pin.questId !== null));
    const quests = pinned ? await listedQuests(deps, playerId, eventId) : new Map();
    return memberMapsOf(door.answer, quests);
  });
}
