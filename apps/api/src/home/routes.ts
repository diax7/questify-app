import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { membershipPending, notEnrolled, unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  memberQuests,
  readHome,
  type HomeDeps,
  type MemberQuest,
  type QuestState,
} from "#src/home/home";

const eventParams = z.object({ eventId: z.uuid() });

const questView = (quest: MemberQuest & Readonly<{ state: QuestState }>) => ({
  id: quest.id,
  title: quest.title,
  description: quest.description,
  type: quest.type,
  points: quest.points,
  repeatCap: quest.repeatCap,
  opensAt: quest.opensAt?.toISOString() ?? null,
  closesAt: quest.closesAt?.toISOString() ?? null,
  done: quest.done,
  earned: quest.earned,
  state: quest.state,
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
 * Inside an event (T-113, T-114): its Home (FR-801, FR-804) and its quests (FR-221, FR-230). Only the event's active
 * members read the quests, each with its state on the database's clock; a pending member reads Home's event and
 * "pending", and the quests answer `membership_pending`. Anyone else, a stranger or a left, removed or banned member,
 * is 403 `not_enrolled`, the same answer whether or not the event exists.
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
    const view = await memberQuests(deps, playerIdOf(request), eventId);
    if (view.kind === "pending") {
      throw membershipPending();
    }
    if (view.kind === "not_member") {
      throw notEnrolled();
    }
    return {
      event: view.event,
      categories: view.categories.map((category) => ({
        id: category.id,
        name: category.name,
        quests: category.quests.map(questView),
      })),
    };
  });
}
