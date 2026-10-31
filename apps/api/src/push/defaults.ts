import { pushTopicsBodySchema, pushTopicsSchema, type PushTopics } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { organizerContextOf } from "#src/organizers/context";
import { pushRefusal, topicsSetTo } from "#src/push/center";

const eventParams = z.object({ eventId: z.uuid() });
const member = { config: { access: "member" } } as const;
const writing = { config: { access: "member" }, bodyLimit: 1024 } as const;

type Pg = Readonly<{ code?: string }>;

/**
 * An event's default notification topics (T-510, FR-1836, migration 0091): the owner or an editor reads which topics start
 * on for the event's players and changes the ones named. A player's own choice still wins, so a change reaches only
 * players who have not chosen the topic. The topics are the player's four (ADR-347); the answer is `true` when a topic
 * starts on.
 */
export function registerPushDefaultsTeamRoutes(
  scope: FastifyInstance,
  deps: Readonly<{ pool: Pool }>,
): void {
  const run = async (
    request: Parameters<typeof organizerContextOf>[0],
    sql: string,
    values: unknown[],
  ): Promise<PushTopics> => {
    try {
      const answer = await withConnection(deps.pool, (client) =>
        withRequestContext(client, organizerContextOf(request), async () => {
          const { rows } = await client.query<{ r: unknown }>(sql, values);
          return rows[0]?.r;
        }),
      );
      return pushTopicsSchema.parse(answer);
    } catch (error) {
      if ((error as Pg).code === "AN404") throw notFound();
      return pushRefusal(error);
    }
  };
  scope.get("/events/:eventId/push-defaults", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    return run(request, "SELECT event_push_defaults($1) AS r", [eventId]);
  });
  scope.put("/events/:eventId/push-defaults", writing, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    const body = parse(pushTopicsBodySchema, request.body);
    return run(request, "SELECT set_event_push_defaults($1, $2::text[], $3::text[], $4) AS r", [
      eventId,
      topicsSetTo(body, true),
      topicsSetTo(body, false),
      request.id,
    ]);
  });
}
