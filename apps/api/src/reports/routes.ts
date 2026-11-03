import { reportRequestSchema, teamHoldsSchema, type ReportRequest } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { invalidReport, notFound, tooManyReports, unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { HttpError } from "#src/http-error";
import { organizerContextOf } from "#src/organizers/context";
import { registerBlockRoutes, type BlockDeps } from "#src/players/block-routes";
import { teamSeat } from "#src/organizers/store";

export type ReportDeps = Readonly<{ pool: Pool }>;

/** Each refusal of `report_content` (migration 0121) as its HTTP answer; anything else rethrows. */
const REFUSALS: Readonly<Record<string, () => HttpError>> = {
  RP404: notFound,
  RP422: invalidReport,
  SV422: invalidReport,
  RP429: tooManyReports,
};

/**
 * A report names a row by id, or a player by username (and the event the name was seen in); never both.
 *
 * @throws HttpError invalid_report for a report that mixes the two.
 */
export function reportTarget(body: ReportRequest): Readonly<{
  targetId: string | null;
  username: string | null;
  eventId: string | null;
}> {
  if (body.kind === "username") {
    if (body.username === undefined || body.targetId !== undefined) {
      throw invalidReport();
    }
    return { targetId: null, username: body.username, eventId: body.eventId ?? null };
  }
  if (body.targetId === undefined || body.username !== undefined || body.eventId !== undefined) {
    throw invalidReport();
  }
  return { targetId: body.targetId, username: null, eventId: null };
}

async function sendReport(pool: Pool, playerId: string, body: ReportRequest): Promise<void> {
  const target = reportTarget(body);
  try {
    await withConnection(pool, (client) =>
      withRequestContext(client, { playerId }, () =>
        client.query("SELECT report_content($1, $2, $3, $4, $5, $6)", [
          body.kind,
          target.targetId,
          target.username,
          target.eventId,
          body.reason,
          body.note ?? null,
        ]),
      ),
    );
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const refusal =
      typeof code === "string" && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : undefined;
    if (refusal === undefined) {
      throw error;
    }
    throw refusal();
  }
}

const own = (request: FastifyRequest): string => {
  if (request.player === undefined) throw unauthenticated();
  return request.player.id;
};

/**
 * A player's report (FR-1411, T-705b): content of an event they are in, or a username. It goes to Questify's queue; a
 * username reported in an event also reaches the event team as a ticket. The answer is the same whether the report is
 * new or the player had already reported the same thing and it is still open, so a retry is harmless. Ten an hour and
 * thirty a day, counted by the database. The username travels in the body, never the URL. Registered with the block
 * list (T-705): a player's two safety tools.
 */
export function registerPlayerSafetyRoutes(app: FastifyInstance, deps: BlockDeps): void {
  registerBlockRoutes(app, deps);
  const change = { config: { access: "player", idempotent: true }, bodyLimit: 4096 } as const;
  app.post("/v1/reports", change, async (request, reply) => {
    const body = parse(reportRequestSchema, request.body);
    await sendReport(deps.pool, own(request), body);
    return reply.code(201).send({ status: "received" });
  });
}

const eventParams = z.object({ eventId: z.uuid() });

/**
 * What Questify unpublished in one event, for its team (T-705b, FR-1414): the dashboard shows the reason and the note
 * on each held item. Read through the table's policy: the organizer's own events in the member's scope only, so another
 * organizer's event answers an empty list.
 */
export function registerContentHoldTeamRoutes(scope: FastifyInstance, deps: ReportDeps): void {
  scope.get(
    "/events/:eventId/content-holds",
    { config: { access: "member" } },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      const { eventId } = parse(eventParams, request.params);
      const context = organizerContextOf(request);
      const rows = await withConnection(deps.pool, (client) =>
        withRequestContext(
          client,
          teamSeat(context),
          async () =>
            (
              await client.query<{ r: unknown }>(
                `SELECT coalesce(jsonb_agg(jsonb_build_object('kind', h.kind, 'targetId', h.target_id,
                        'reasonCode', h.reason_code, 'note', h.note, 'heldAt', h.held_at) ORDER BY h.held_at DESC),
                      '[]'::jsonb) AS r
               FROM content_hold h WHERE h.event_id = $1 AND h.released_at IS NULL`,
                [eventId],
              )
            ).rows[0]?.r,
        ),
      );
      return teamHoldsSchema.parse({ holds: rows });
    },
  );
}
