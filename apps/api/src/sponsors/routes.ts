import {
  memberSponsorsSchema,
  sponsorBodySchema,
  sponsorTagBodySchema,
  type MemberSponsors,
  type TeamSponsor,
} from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import type { HomeDeps } from "#src/home/home";
import { organizerContextOf } from "#src/organizers/context";
import { sponsorCall, sponsorError, type SponsorDeps } from "#src/sponsors/store";

const eventParams = z.object({ eventId: z.uuid() });
const sponsorParams = eventParams.extend({ sponsorId: z.uuid() });

/** A write by the team: the caller's access to the event is asked again before a stored answer is replayed. */
const writing = (deps: SponsorDeps) =>
  ({
    config: { access: "member", idempotent: true },
    preValidation: async (request: FastifyRequest) => {
      const { eventId } = parse(eventParams, request.params);
      await sponsorCall(deps, organizerContextOf(request), "SELECT sponsor_authorize($1)", [
        eventId,
      ]);
    },
  }) as const;

/** The body checked by `schema`, or the first failing field in the words the dashboard maps to a message. */
function bodyOf<Schema extends z.ZodType>(schema: Schema, body: unknown): z.output<Schema> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path[0];
  throw sponsorError(422, "invalid_sponsor", {
    issue: typeof field === "string" ? field : "sponsor",
  });
}

/** The dashboard's side (T-507): the sponsors with their tags, add, edit, delete, and tag an item. */
export function registerSponsorTeamRoutes(scope: FastifyInstance, deps: SponsorDeps): void {
  const run = <Row extends object>(request: FastifyRequest, sql: string, values: unknown[]) =>
    sponsorCall<Row>(deps, organizerContextOf(request), sql, values);
  const member = { config: { access: "member" } } as const;
  scope.get("/events/:eventId/sponsors", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    const result = await run<{ sponsors: TeamSponsor[] }>(
      request,
      "SELECT sponsor_list($1) AS sponsors",
      [eventId],
    );
    return { sponsors: result.sponsors };
  });
  scope.post("/events/:eventId/sponsors", writing(deps), async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const draft = JSON.stringify(bodyOf(sponsorBodySchema, request.body));
    const result = await run<{ sponsor: TeamSponsor }>(
      request,
      "SELECT sponsor_save($1, $2::jsonb, NULL, $3) AS sponsor",
      [eventId, draft, request.id],
    );
    return reply.code(201).send(result.sponsor);
  });
  scope.put("/events/:eventId/sponsor-tags", writing(deps), async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const tag = bodyOf(sponsorTagBodySchema, request.body);
    const result = await run<{ sponsors: TeamSponsor[] }>(
      request,
      "SELECT sponsor_tag_set($1, $2, $3, $4, $5) AS sponsors",
      [eventId, tag.kind, tag.targetId, tag.sponsorId, request.id],
    );
    return { sponsors: result.sponsors };
  });
  scope.put("/events/:eventId/sponsors/:sponsorId", writing(deps), async (request) => {
    const { eventId, sponsorId } = parse(sponsorParams, request.params);
    const draft = JSON.stringify(bodyOf(sponsorBodySchema, request.body));
    const result = await run<{ sponsor: TeamSponsor }>(
      request,
      "SELECT sponsor_save($1, $2::jsonb, $3, $4) AS sponsor",
      [eventId, draft, sponsorId, request.id],
    );
    return result.sponsor;
  });
  scope.delete("/events/:eventId/sponsors/:sponsorId", writing(deps), async (request) => {
    const { eventId, sponsorId } = parse(sponsorParams, request.params);
    const result = await run<{ lost: number }>(
      request,
      "SELECT sponsor_delete($1, $2, $3) AS lost",
      [eventId, sponsorId, request.id],
    );
    return { tagsLost: result.lost };
  });
}

const player = { config: { access: "player" } } as const;

/** The player's side (T-507): the event's sponsors and the tags on the items the player may see. */
export function registerMemberSponsorRoutes(app: FastifyInstance, deps: HomeDeps): void {
  app.get("/v1/events/:eventId/sponsors", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    if (request.player === undefined) throw unauthenticated();
    const door = await sponsorCall<{ answer: MemberSponsors }>(
      deps,
      { playerId: request.player.id },
      "SELECT member_sponsors($1) AS answer",
      [eventId],
    );
    return memberSponsorsSchema.parse(door.answer);
  });
}
