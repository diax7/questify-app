import { createHash } from "node:crypto";
import { souvenirBodySchema } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import { asSouvenirTeam, souvenirList, type SouvenirDeps } from "#src/souvenirs/souvenirs";
import { paySouvenirs } from "#src/souvenirs/payer";

const eventParams = z.object({ eventId: z.uuid() });
const ruleParams = z.object({ eventId: z.uuid(), souvenirId: z.uuid() });
const writing = { config: { access: "member", idempotent: true }, bodyLimit: 8192 } as const;
const empty = z.union([z.strictObject({}), z.null(), z.undefined()]);
const activation = z.strictObject({
  targetIds: z
    .array(z.uuid())
    .max(10000)
    .refine((ids) => new Set(ids).size === ids.length),
});

/** Stable across a crash after DB commit, scoped to actor/tenant/path. No submitted text or raw key is stored. */
function commandId(request: FastifyRequest): string {
  const actor = organizerContextOf(request);
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        actor.organizerId,
        actor.staffUserId,
        request.method,
        request.url.split("?")[0],
        request.headers["idempotency-key"],
      ]),
    )
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function registerSouvenirRoutes(scope: FastifyInstance, deps: SouvenirDeps) {
  scope.get(
    "/events/:eventId/souvenirs",
    { config: { access: "member" } },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      const { eventId } = parse(eventParams, request.params);
      return asSouvenirTeam(deps, organizerContextOf(request), (client) =>
        souvenirList(client, eventId),
      );
    },
  );
  scope.post("/events/:eventId/souvenirs", writing, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(souvenirBodySchema, request.body);
    const result = await asSouvenirTeam(deps, organizerContextOf(request), async (client) => {
      await client.query("SELECT souvenir_save($1,NULL,$2,$3)", [
        eventId,
        body,
        commandId(request),
      ]);
      return souvenirList(client, eventId);
    });
    return reply.code(201).send(result);
  });
  scope.patch("/events/:eventId/souvenirs/:souvenirId", writing, async (request) => {
    const { eventId, souvenirId } = parse(ruleParams, request.params);
    const body = parse(souvenirBodySchema, request.body);
    return asSouvenirTeam(deps, organizerContextOf(request), async (client) => {
      await client.query("SELECT souvenir_save($1,$2,$3,$4)", [
        eventId,
        souvenirId,
        body,
        commandId(request),
      ]);
      return souvenirList(client, eventId);
    });
  });
  for (const action of ["activate", "stop", "delete"] as const) {
    const url = `/events/:eventId/souvenirs/:souvenirId${action === "delete" ? "" : `/${action}`}`;
    scope.route({
      method: action === "delete" ? "DELETE" : "POST",
      url,
      ...writing,
      handler: async (request) => {
        const { eventId, souvenirId } = parse(ruleParams, request.params);
        const targets = action === "activate" ? parse(activation, request.body).targetIds : null;
        if (action !== "activate") parse(empty, request.body);
        return asSouvenirTeam(deps, organizerContextOf(request), async (client) => {
          await client.query("SELECT souvenir_action($1,$2,$3,$4,$5)", [
            eventId,
            souvenirId,
            action,
            commandId(request),
            targets,
          ]);
          return souvenirList(client, eventId);
        });
      },
    });
  }
  scope.post("/events/:eventId/souvenirs/process", writing, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    parse(empty, request.body);
    const actor = organizerContextOf(request);
    await asSouvenirTeam(deps, actor, (client) =>
      client.query("SELECT souvenir_request($1,$2)", [eventId, commandId(request)]),
    );
    const totals = await paySouvenirs(deps, { eventId });
    const list = await asSouvenirTeam(deps, actor, (client) => souvenirList(client, eventId));
    return {
      ...list,
      ...totals,
      status: list.due === 0 && list.scanning === 0 ? "complete" : "pending",
    };
  });
}
