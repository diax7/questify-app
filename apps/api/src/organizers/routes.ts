import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  alreadyMember,
  emailUnavailable,
  invalidRequest,
  invalidScope,
  inviteSelf,
  invitesPendingFull,
  mailCap,
  notFound,
  ownerOnly,
  ownerRequired,
  tooManyAttempts,
} from "#src/auth/http-errors";
import { registerActivationRoutes } from "#src/activation/routes";
import type { Activation } from "#src/activation/service";
import { registerAudienceRoutes } from "#src/audience/routes";
import { registerRehearsalTeamRoutes } from "#src/rehearsal/routes";
import type { Rehearsal } from "#src/rehearsal/service";
import type { Sessions } from "#src/auth/session";
import { callerOf, parse } from "#src/auth/request";
import { checkOrigin, requireSession } from "#src/auth/staff-guard";
import type { Events } from "#src/events/events";
import { registerEventRoutes } from "#src/events/routes";
import { registerJoinSetupRoutes } from "#src/join/setup-routes";
import { registerAwardRoutes } from "#src/awards/routes";
import { registerFlagRoutes } from "#src/flags/routes";
import { registerResultsTeamRoutes } from "#src/results/routes";
import { registerModerationRoutes } from "#src/moderation/routes";
import type { OperatorsDeps } from "#src/operators/operators";
import { registerOperatorRoutes } from "#src/operators/routes";
import type { QuestCodeKey } from "#src/quests/qr";
import { registerBuilderRoutes } from "#src/quests/routes";
import type { RewardCodeKey } from "#src/rewards/codes";
import { registerRewardBuilderRoutes } from "#src/rewards/routes";
import { organizerContextOf } from "#src/organizers/context";
import { membershipOf, readTeam } from "#src/organizers/store";
import type { Actor, ChangeResult, InviteResult, Team } from "#src/organizers/team";
import { ORGANIZER_PREFIX } from "#src/route-access";
import type { SettingsService } from "#src/settings/service";

export type OrganizerRoutesDeps = Readonly<{
  pool: Pool;
  sessions: Sessions;
  team: Team;
  events: Events;
  settings: SettingsService;
  activation: Activation;
  /** The team's rehearsal card, code and erase (T-211). */
  rehearsal: Rehearsal;
  /** Signs the printed quest codes, which point at the dashboard's `/q/{token}` page. */
  questCodes: Readonly<{ codeKey: QuestCodeKey; codeOrigin: string }>;
  /** Seals and marks digital reward codes before they reach the database (T-203). */
  rewardCodeKey: RewardCodeKey;
  /** Operator invites: signed claim addresses and the invite email (T-204). */
  operators: OperatorsDeps;
  dashboardOrigin: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 8192;
const MAX_SCOPE = 200;

const scopeList = z.array(z.uuid()).min(1).max(MAX_SCOPE);
const language = z.enum(["ar", "en"]).default("ar");
const inviteBody = z.object({
  email: z.string().min(3).max(254),
  eventScope: scopeList.optional(),
  lang: language,
});
const ownershipBody = z.object({ email: z.string().min(3).max(254), lang: language });
const scopeBody = z.object({ eventScope: scopeList.nullable() });
const memberParams = z.object({ staffUserId: z.uuid() });
const inviteParams = z.object({ inviteId: z.uuid() });

function actorOf(request: FastifyRequest): Actor {
  const context = organizerContextOf(request);
  return {
    organizerId: context.organizerId,
    staffUserId: context.staffUserId,
    email: context.email,
  };
}

function answerInvite(reply: FastifyReply, result: InviteResult) {
  switch (result.kind) {
    case "invited":
      return reply.code(201).send({ id: result.id });
    case "invalid_email":
      throw invalidRequest();
    case "self":
      throw inviteSelf();
    case "already_member":
      throw alreadyMember();
    case "invalid_scope":
      throw invalidScope();
    case "mail_cap":
      throw mailCap();
    case "pending_full":
      throw invitesPendingFull();
    case "email_unavailable":
      throw emailUnavailable();
    case "throttled":
      reply.header("retry-after", String(result.retryAfterSeconds));
      throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
  }
}

function answerChange(reply: FastifyReply, result: ChangeResult) {
  switch (result.kind) {
    case "done":
      return reply.code(204).send();
    case "not_found":
      throw notFound();
    case "owner_required":
      throw ownerRequired();
    case "invalid_scope":
      throw invalidScope();
  }
}

const member = { config: { access: "member" } } as const;
const owner = { config: { access: "owner" }, bodyLimit: BODY_LIMIT } as const;

function registerTeamRoutes(scope: FastifyInstance, deps: OrganizerRoutesDeps): void {
  scope.get("/members", member, async (request) =>
    readTeam(deps.pool, organizerContextOf(request)),
  );

  scope.post("/invites", owner, async (request, reply) => {
    const body = parse(inviteBody, request.body);
    const result = await deps.team.invite(
      actorOf(request),
      { email: body.email, role: "editor", eventScope: body.eventScope, lang: body.lang },
      callerOf(request),
    );
    return answerInvite(reply, result);
  });

  scope.post("/ownership", owner, async (request, reply) => {
    const body = parse(ownershipBody, request.body);
    const result = await deps.team.invite(
      actorOf(request),
      { email: body.email, role: "owner", lang: body.lang },
      callerOf(request),
    );
    return answerInvite(reply, result);
  });

  scope.delete("/invites/:inviteId", owner, async (request, reply) => {
    const { inviteId } = parse(inviteParams, request.params);
    return answerChange(
      reply,
      await deps.team.cancelInvite(actorOf(request), inviteId, callerOf(request)),
    );
  });

  scope.patch("/members/:staffUserId", owner, async (request, reply) => {
    const { staffUserId } = parse(memberParams, request.params);
    const body = parse(scopeBody, request.body);
    return answerChange(
      reply,
      await deps.team.setScope(actorOf(request), staffUserId, body.eventScope, callerOf(request)),
    );
  });

  // A static segment wins over the parameter, so `me` never reaches the owner's remove route.
  scope.delete("/members/me", member, async (request, reply) => {
    const { organizer } = organizerContextOf(request);
    return answerChange(
      reply,
      await deps.team.leave(actorOf(request), organizer.role, callerOf(request)),
    );
  });

  scope.delete("/members/:staffUserId", owner, async (request, reply) => {
    const { staffUserId } = parse(memberParams, request.params);
    return answerChange(
      reply,
      await deps.team.remove(actorOf(request), staffUserId, callerOf(request)),
    );
  });
}

/**
 * Registers every /v1/organizers/:organizerId route in one scope. Its hook runs the staff checks (no-store, Origin,
 * session), then reads the caller's membership of that organizer from the database: a non-member gets 404, the same
 * as an organizer that does not exist, and an editor on an `owner` route gets 403. The database checks the
 * membership again on every query (migration 0008).
 */
export function registerOrganizerRoutes(app: FastifyInstance, deps: OrganizerRoutesDeps): void {
  app.register(
    async (scope) => {
      scope.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "no-store");
        checkOrigin(request, deps.dashboardOrigin, true);
        await requireSession(request, reply, deps.sessions);
        const { organizerId } = request.params as { organizerId?: string };
        const staff = request.staff;
        // Stryker disable next-line ConditionalExpression,LogicalOperator: the route pattern always has the id and the session check sets the staff member
        if (organizerId === undefined || !UUID.test(organizerId) || staff === undefined) {
          throw notFound();
        }
        const membership = await membershipOf(deps.pool, staff.account.id, organizerId);
        if (membership === undefined) {
          throw notFound();
        }
        if (request.routeOptions.config.access === "owner" && membership.role !== "owner") {
          throw ownerOnly();
        }
        request.organizer = membership;
      });
      registerTeamRoutes(scope, deps);
      registerEventRoutes(scope, deps.events, deps.settings);
      registerActivationRoutes(scope, deps.activation);
      registerRehearsalTeamRoutes(scope, deps.rehearsal);
      registerBuilderRoutes(scope, { pool: deps.pool, ...deps.questCodes });
      registerRewardBuilderRoutes(scope, { pool: deps.pool, codeKey: deps.rewardCodeKey });
      registerModerationRoutes(scope, { pool: deps.pool });
      registerAwardRoutes(scope, { pool: deps.pool });
      registerFlagRoutes(scope, { pool: deps.pool });
      registerResultsTeamRoutes(scope, { pool: deps.pool });
      registerOperatorRoutes(scope, deps.operators);
      registerJoinSetupRoutes(scope, { pool: deps.pool });
      registerAudienceRoutes(scope, { pool: deps.pool });
    },
    { prefix: ORGANIZER_PREFIX },
  );
}
