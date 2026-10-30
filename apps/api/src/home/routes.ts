import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseLimit } from "@questify/shared";
import {
  invalidRequest,
  membershipPending,
  notEnrolled,
  unauthenticated,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  memberActivity,
  memberQuests,
  readHome,
  type HomeDeps,
  type MemberQuest,
  type QuestState,
  type RunningBoost,
} from "#src/home/home";
import { registerRecapRoutes } from "#src/recap/routes";
import { registerMemberAnnouncementRoutes } from "#src/announcements/routes";
import { registerMemberSessionRoutes } from "#src/sessions/routes";
import { registerMemberMapRoutes } from "#src/maps/routes";
import { registerMemberSponsorRoutes } from "#src/sponsors/routes";

const eventParams = z.object({ eventId: z.uuid() });
const activityQuery = z.strictObject({
  cursor: z.string().max(20).optional(),
  limit: z.string().optional(),
});
/** A ledger id: the cursor of the history, opaque to the app; 18 digits at most, so it always fits a bigint. */
const LEDGER_ID = /^[1-9][0-9]{0,17}$/;

function activityPage(query: z.infer<typeof activityQuery>): {
  beforeId: string | null;
  limit: number;
} {
  if (query.cursor !== undefined && !LEDGER_ID.test(query.cursor)) {
    throw invalidRequest();
  }
  try {
    return { beforeId: query.cursor ?? null, limit: parseLimit(query.limit) };
  } catch {
    throw invalidRequest();
  }
}

/** A running boost as the app reads it (T-307). */
const boostView = (boost: RunningBoost | null) =>
  boost === null ? null : { multiplier: boost.multiplier, endsAt: boost.endsAt.toISOString() };

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
  verification: quest.verification,
  state: quest.state,
  lock: quest.lock,
  steps: quest.steps,
  item: quest.item,
  place: quest.place,
  communityLock: quest.communityLock,
  meet: quest.meet,
  game: quest.game,
  flash: quest.flash === null ? null : { closesAt: quest.flash.closesAt.toISOString() },
  boost: boostView(quest.boost),
  firstBonus: quest.firstBonus,
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
 * Inside an event (T-113, T-114): its Home (FR-801, FR-804), its quests (FR-221, FR-230) and its recap (T-410,
 * `recap/routes.ts`). Only the event's active members read the quests, each with its state on the database's clock; a
 * pending member reads Home's event and "pending" (or "declined", ADR-167), and the quests answer `membership_pending`
 * to a pending one. Anyone else, a stranger or a left, removed, banned or declined member, is 403 `not_enrolled`, the
 * same answer whether or not the event exists.
 */
export function registerHomeRoutes(app: FastifyInstance, deps: HomeDeps): void {
  registerRecapRoutes(app, deps);
  registerMemberAnnouncementRoutes(app, deps);
  registerMemberSessionRoutes(app, deps);
  registerMemberMapRoutes(app, deps);
  registerMemberSponsorRoutes(app, deps);
  app.get("/v1/events/:eventId/home", { config: { access: "player" } }, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const home = await readHome(deps, playerIdOf(request), eventId);
    if (home === null) {
      throw notEnrolled();
    }
    return home;
  });

  // FR-410: the player's own points record in this event, newest first, page by page.
  app.get("/v1/events/:eventId/activity", { config: { access: "player" } }, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { beforeId, limit } = activityPage(parse(activityQuery, request.query));
    const view = await memberActivity(deps, playerIdOf(request), { eventId, beforeId, limit });
    if (view.kind === "pending") {
      throw membershipPending();
    }
    if (view.kind === "not_member") {
      throw notEnrolled();
    }
    const last = view.entries.at(-1);
    return {
      entries: view.entries,
      nextCursor: view.entries.length === limit && last !== undefined ? last.id : null,
    };
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
        orderMode: category.orderMode,
        opensAt: category.opensAt?.toISOString() ?? null,
        unlockAfter: category.unlockAfter,
        bonus: category.bonus,
        refresh: category.refresh,
        resetsAt: category.resetsAt?.toISOString() ?? null,
        communityLock: category.communityLock,
        boost: boostView(category.boost),
        quests: category.quests.map(questView),
      })),
    };
  });
}
