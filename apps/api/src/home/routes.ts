import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notEnrolled, unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { memberQuests, readHome, type HomeDeps, type MemberQuest } from "#src/home/home";

const eventParams = z.object({ eventId: z.uuid() });

const questView = (quest: MemberQuest) => ({
  id: quest.id,
  title: quest.title,
  description: quest.description,
  type: quest.type,
  points: quest.points,
  repeatCap: quest.repeatCap,
  opensAt: quest.opensAt?.toISOString() ?? null,
  closesAt: quest.closesAt?.toISOString() ?? null,
  done: quest.done,
});

function playerIdOf(request: { player?: { id: string } | undefined }): string {
  const player = request.player;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (player === undefined) {
    throw unauthenticated();
  }
  return player.id;
}

/**
 * Inside an event (T-113): its Home (FR-801, FR-804) and its quests (T-114's tab). Only the event's active members read
 * the quests; a pending member reads Home's event and "pending". Anyone else, a stranger or a left, removed or banned
 * member, is 403 `not_enrolled`, the same answer whether or not the event exists.
 */
export function registerHomeRoutes(app: FastifyInstance, deps: HomeDeps): void {
  app.get("/v1/events/:eventId/home", { config: { access: "player" } }, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const home = await readHome(deps, playerIdOf(request), eventId);
    if (home === null) {
      throw notEnrolled();
    }
    return home;
  });

  app.get("/v1/events/:eventId/quests", { config: { access: "player" } }, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const categories = await memberQuests(deps, playerIdOf(request), eventId);
    if (categories === null) {
      throw notEnrolled();
    }
    return {
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        quests: category.quests.map(questView),
      })),
    };
  });
}
