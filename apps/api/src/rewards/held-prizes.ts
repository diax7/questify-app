import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { notFound, unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { deskViewOf, sourceOf, type DeskView, type RedemptionSource } from "#src/desk/desk";
import { organizerContextOf } from "#src/organizers/context";
import type { Bilingual } from "#src/quests/store";

export type HeldPrizeDeps = Readonly<{ pool: Pool }>;

/** One prize the player holds and has not collected: no price, no code, nothing a handover would still need to hide. */
export type HeldPrize = Readonly<{
  id: string;
  kind: string;
  name: Bilingual;
  /** The pickup time of a shop reservation; the claim deadline of a rank or quest prize. */
  reservedUntil: string | null;
  /** The player's live Collect (collect first), or null. */
  collectUntil: string | null;
  rank: number | null;
  source: RedemptionSource;
}>;

export type HeldPrizesView = Readonly<{ desk: DeskView; prizes: readonly HeldPrize[] }>;

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);
const textOf = (ar: unknown, en: unknown): Bilingual => ({
  ar: typeof ar === "string" ? ar : null,
  en: typeof en === "string" ? en : null,
});

/**
 * The prizes a member holds in an event, soonest deadline first, and the desk to collect them from (T-602d). It reads
 * what the shop reads (`event_shop`, `my_redemptions`) and keeps only the reserved ones, so it names the bearer's own
 * holdings and nothing else. It is not behind the shop switch: a prize reserved before the shop went off stays
 * collectable. Undefined for anyone who is not an active member (not found, never "forbidden").
 */
export function readHeldPrizes(
  deps: HeldPrizeDeps,
  request: Readonly<{ playerId: string; eventId: string }>,
): Promise<HeldPrizesView | undefined> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId: request.playerId }, async () => {
      const { rows: shops } = await client.query("SELECT * FROM event_shop($1)", [request.eventId]);
      const shop = shops[0];
      if (shop === undefined) {
        return undefined;
      }
      const { rows: mine } = await client.query("SELECT * FROM my_redemptions($1)", [
        request.eventId,
      ]);
      const prizes = mine
        .filter((row) => row["status"] === "reserved")
        .map((row): HeldPrize => ({
          id: String(row["id"]),
          kind: String(row["kind"]),
          name: textOf(row["name_ar"], row["name_en"]),
          reservedUntil: iso(row["reserved_until"]),
          collectUntil: iso(row["collect_until"]),
          rank: typeof row["rank"] === "number" ? row["rank"] : null,
          source: sourceOf(row["source"]),
        }))
        .toSorted((a, b) => Date.parse(a.reservedUntil ?? "") - Date.parse(b.reservedUntil ?? ""));
      return { desk: deskViewOf(shop), prizes };
    }),
  );
}

/**
 * How many prizes players of the event still hold (T-602d): reserved, not yet handed over, cancelled or expired, for
 * members who are still active. Read under the team member's own row-level security, so another organizer's event, or
 * one outside an editor's limit, is not found.
 */
export function countHeldPrizes(
  deps: HeldPrizeDeps,
  actor: Readonly<{ organizerId: string; staffUserId: string }>,
  eventId: string,
): Promise<number | undefined> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(
      client,
      { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
      async () => {
        const { rows: found } = await client.query(
          "SELECT 1 FROM event WHERE organizer_id = $1 AND id = $2",
          [actor.organizerId, eventId],
        );
        if (found.length === 0) {
          return undefined;
        }
        const { rows } = await client.query<{ held: string }>(
          `SELECT count(*) AS held
           FROM redemption d JOIN enrollment n ON n.id = d.enrollment_id
           WHERE d.event_id = $1 AND d.status = 'reserved' AND n.status = 'active'`,
          [eventId],
        );
        return Number(rows[0]?.held ?? 0);
      },
    ),
  );
}

const eventParams = z.object({ eventId: z.uuid() });

/** `GET /v1/events/:eventId/held-prizes`: the player's own uncollected prizes (T-602d); 404 for a non-member. */
export function registerHeldPrizesRoute(app: FastifyInstance, deps: HeldPrizeDeps): void {
  app.get(
    "/v1/events/:eventId/held-prizes",
    { config: { access: "player" } },
    async (request, reply) => {
      const { eventId } = parse(eventParams, request.params);
      // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
      if (request.player === undefined) {
        throw unauthenticated();
      }
      const view = await readHeldPrizes(deps, { playerId: request.player.id, eventId });
      if (view === undefined) {
        throw notFound();
      }
      reply.header("cache-control", "no-store");
      return view;
    },
  );
}

/** `GET …/events/:eventId/held-prizes` for the team: how many prizes players still hold, for the shop's off note. */
export function registerHeldPrizesTeamRoute(scope: FastifyInstance, deps: HeldPrizeDeps): void {
  scope.get(
    "/events/:eventId/held-prizes",
    { config: { access: "member" }, bodyLimit: 1024 },
    async (request) => {
      const { eventId } = parse(eventParams, request.params);
      const held = await countHeldPrizes(deps, organizerContextOf(request), eventId);
      if (held === undefined) {
        throw notFound();
      }
      return { held };
    },
  );
}
