import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  alreadyMember,
  emailUnavailable,
  eventSuspended,
  invalidRequest,
  invalidScope,
  inviteSelf,
  invitesPendingFull,
  mailCap,
  notFound,
  organizerAcceptanceRequired,
  organizerSuspended,
  ownerOnly,
  ownerRequired,
  supportViewOnly,
  tooManyAttempts,
} from "#src/auth/http-errors";
import { registerOrganizerLegalRoutes } from "#src/legal/organizer-routes";
import { registerActivationRoutes } from "#src/activation/routes";
import type { Activation } from "#src/activation/service";
import { registerAudienceRoutes } from "#src/audience/routes";
import { registerRehearsalTeamRoutes } from "#src/rehearsal/routes";
import type { Rehearsal } from "#src/rehearsal/service";
import type { Sessions } from "#src/auth/session";
import { callerOf, parse } from "#src/auth/request";
import { checkOrigin, requireSession } from "#src/auth/staff-guard";
import type { Events } from "#src/events/events";
import type { SuspendedSet } from "#src/events/suspended-set";
import { registerEventRoutes } from "#src/events/routes";
import { registerJoinSetupRoutes } from "#src/join/setup-routes";
import { registerAwardRoutes } from "#src/awards/routes";
import { registerSubmissionTeamRoutes } from "#src/submissions/routes";
import { registerTicketTeamRoutes } from "#src/tickets/routes";
import { registerPlayTeamRoutes } from "#src/plays/routes";
import { registerPushDefaultsTeamRoutes } from "#src/push/defaults";
import { registerBoostTeamRoutes } from "#src/boosts/routes";
import { registerAnnouncementTeamRoutes } from "#src/announcements/routes";
import { registerContentHoldTeamRoutes } from "#src/reports/routes";
import { registerSessionTeamRoutes } from "#src/sessions/routes";
import { registerSetupRoutes } from "#src/setup/routes";
import { registerMapTeamRoutes } from "#src/maps/routes";
import { registerCheersTeamRoutes } from "#src/cheers/routes";
import { registerRatingTeamRoutes } from "#src/ratings/routes";
import { registerSponsorTeamRoutes } from "#src/sponsors/routes";
import { registerOrganizerAlertRoutes } from "#src/organizer-alerts/routes";
import { registerStreakTeamRoutes } from "#src/streaks/routes";
import { registerNfcTeamRoutes } from "#src/nfc/routes";
import type { ClaimDeps } from "#src/devices/claims";
import { registerDeviceTeamRoutes } from "#src/devices/routes";
import { registerScreenTeamRoutes } from "#src/screen/routes";
import { registerCommunityTeamRoutes } from "#src/community/routes";
import { registerSouvenirRoutes } from "#src/souvenirs/routes";
import type { InvitationDeps } from "#src/invitation-campaigns/campaigns";
import { registerInvitationTeamRoutes } from "#src/invitation-campaigns/routes";
import { registerFlagRoutes } from "#src/flags/routes";
import { registerResultsTeamRoutes } from "#src/results/routes";
import { registerQuestItemRoutes } from "#src/rewards/quest-item-routes";
import { registerModerationRoutes } from "#src/moderation/routes";
import type { OperatorsDeps } from "#src/operators/operators";
import { registerOperatorActivityRoutes } from "#src/operators/activity-routes";
import { registerOperatorRoutes } from "#src/operators/routes";
import type { QuestCodeKey, RevealCodeKey, StepCodeKey } from "#src/quests/qr";
import { registerAnalyticsTeamRoutes } from "#src/analytics/routes";
import { registerChangeSetRoutes } from "#src/change-sets/routes";
import { registerBuilderRoutes } from "#src/quests/routes";
import type { RewardCodeKey } from "#src/rewards/codes";
import { createControlReader } from "#src/control/control";
import { registerControlTeamRoutes } from "#src/control/routes";
import { registerInboxTeamRoutes } from "#src/inbox/routes";
import { registerReadinessTeamRoutes } from "#src/readiness/routes";
import { registerHeldPrizesTeamRoute } from "#src/rewards/held-prizes";
import { registerRewardBuilderRoutes } from "#src/rewards/routes";
import { organizerContextOf } from "#src/organizers/context";
import { membershipOf, readTeam, type OrganizerPrincipal } from "#src/organizers/store";
import { supportMayUse, supportSeatOf, viewGrantOf } from "#src/organizers/support-seat";
import { enterView, isRead } from "#src/organizers/support-view";
import type { AuthKeys } from "#src/auth/keys";
import type { Actor, ChangeResult, InviteResult, Team } from "#src/organizers/team";
import type { Ranking } from "#src/ranking/ranking";
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
  questCodes: Readonly<{
    codeKey: QuestCodeKey;
    stepKey: StepCodeKey;
    revealKey: RevealCodeKey;
    codeOrigin: string;
  }>;
  /** Seals and marks digital reward codes before they reach the database (T-203). */
  rewardCodeKey: RewardCodeKey;
  /** Operator invites: signed claim addresses and the invite email (T-204). */
  operators: OperatorsDeps;
  /** Moves a player's place after a reviewer approves their submission (T-301). */
  ranking: Ranking;
  /** Pairing codes claimed from the Devices page, and its lists and revokes (T-309). */
  devices: ClaimDeps;
  /** Questify invitations requested by the owner (T-409). */
  invitations: InvitationDeps;
  /** The suspended events (T-701): a member's writes to one answer 423. */
  suspended: SuspendedSet;
  /** Keys the support view's read throttle per admin (T-712). */
  keys: Pick<AuthKeys, "userKey">;
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

/** The caller's membership of the organizer in the URL, else a live support grant in it (T-701), else 404. */
async function principalOf(pool: Pool, request: FastifyRequest): Promise<OrganizerPrincipal> {
  const { organizerId } = request.params as { organizerId?: string };
  const staff = request.staff;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: the route pattern always has the id and the session check sets the staff member
  if (organizerId === undefined || !UUID.test(organizerId) || staff === undefined) {
    throw notFound();
  }
  const membership =
    (await membershipOf(pool, staff.account.id, organizerId)) ??
    (await supportSeatOf(pool, staff.account, organizerId));
  if (membership === undefined) {
    throw notFound();
  }
  return membership;
}

/**
 * Team writes that stay open while an organizer or event is suspended: leaving, and an owner removing a member, so a
 * compromised account can be cut off. Keys are the method and the route pattern below the organizer prefix.
 */
const OPEN_WHILE_SUSPENDED = new Set(["DELETE /members/me", "DELETE /members/:staffUserId"]);

/** True for a read, for support (Q-377), and for the team doors that stay open while suspended. */
function staysOpenWhileSuspended(request: FastifyRequest, membership: OrganizerPrincipal): boolean {
  const { method } = request;
  if (method === "GET" || method === "HEAD" || membership.support !== undefined) {
    return true;
  }
  return OPEN_WHILE_SUSPENDED.has(
    `${method} ${(request.routeOptions.url ?? "").slice(ORGANIZER_PREFIX.length)}`,
  );
}

/**
 * What a team can still do while organizer documents wait for the owner (ADR-446): read everything, leave, an owner
 * removing a member, and the owner's acceptance itself. Keys are the method and the route pattern below the prefix.
 */
const OPEN_WHILE_UNACCEPTED = new Set([
  "POST /legal/accept",
  "DELETE /members/me",
  "DELETE /members/:staffUserId",
]);

/**
 * A new version of an organizer document is out (FR-1781): the team's writes answer 403 until the owner accepts it. A
 * read stays open so the page can say what to accept; support never carries the organizer's acceptance.
 */
function refuseUnacceptedWrite(request: FastifyRequest, membership: OrganizerPrincipal): void {
  const pending = membership.legalPending ?? [];
  if (pending.length === 0 || membership.support !== undefined) {
    return;
  }
  const { method } = request;
  const key = `${method} ${(request.routeOptions.url ?? "").slice(ORGANIZER_PREFIX.length)}`;
  if (method === "GET" || method === "HEAD" || OPEN_WHILE_UNACCEPTED.has(key)) {
    return;
  }
  throw organizerAcceptanceRequired({
    documents: pending.map(({ document, version }) => ({ id: document, version })),
  });
}

/**
 * A suspended organizer or event is read-only to its team (ADR-406): any write answers 423, but the team doors above.
 * Support keeps writing so it can fix what led to the suspension (Q-377); the ledger stays closed to it in the
 * database.
 */
async function refuseSuspendedWrite(
  request: FastifyRequest,
  params: Readonly<{ eventId?: string }>,
  membership: OrganizerPrincipal,
  suspended: SuspendedSet,
): Promise<void> {
  if (staysOpenWhileSuspended(request, membership)) {
    return;
  }
  if (membership.suspension !== undefined && membership.suspension !== null) {
    throw organizerSuspended();
  }
  if (params.eventId !== undefined && (await suspended.has(params.eventId))) {
    throw eventSuspended();
  }
}

/**
 * Support's gate (T-701, T-712): a write on an event under a view grant (or any write while a view is held, without an
 * event) answers 403 `support_view_only` before any handler runs; then the deny-by-default list (404).
 */
function refuseSupport(
  request: FastifyRequest,
  params: Readonly<{ eventId?: string }>,
  membership: OrganizerPrincipal,
): void {
  if (membership.support === undefined) {
    return;
  }
  if (viewGrantOf(params, membership) !== undefined && !isRead(request.method)) {
    throw supportViewOnly();
  }
  if (!supportMayUse(request.method, request.routeOptions.url ?? "", params, membership)) {
    throw notFound();
  }
}

/**
 * Registers every /v1/organizers/:organizerId route in one scope. Its hook runs the staff checks (no-store, Origin,
 * session), then reads the caller's membership of that organizer from the database: a non-member gets 404, the same
 * as an organizer that does not exist, and an editor on an `owner` route gets 403. A Questify admin with a live support
 * grant is seated as an editor of the granted events, on a deny-by-default list of routes (T-701); under a `view` grant
 * only reads pass, each throttled and logged, and its database work runs in read-only transactions (T-712). The database checks
 * the membership or the grant again on every query (migrations 0008, 0114).
 */
export function registerOrganizerRoutes(app: FastifyInstance, deps: OrganizerRoutesDeps): void {
  app.register(
    async (scope) => {
      scope.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "no-store");
        checkOrigin(request, deps.dashboardOrigin, true);
        await requireSession(request, reply, deps.sessions);
        const membership = await principalOf(deps.pool, request);
        const params = request.params as { eventId?: string };
        refuseSupport(request, params, membership);
        if (request.routeOptions.config.access === "owner" && membership.role !== "owner") {
          throw ownerOnly();
        }
        await refuseSuspendedWrite(request, params, membership, deps.suspended);
        refuseUnacceptedWrite(request, membership);
        const view = viewGrantOf(params, membership);
        if (view !== undefined) {
          await enterView(deps, request, reply, view);
        }
        request.organizer = view === undefined ? membership : { ...membership, readOnly: true };
      });
      registerTeamRoutes(scope, deps);
      registerOrganizerLegalRoutes(scope, { pool: deps.pool });
      registerOrganizerAlertRoutes(scope, { pool: deps.pool });
      registerEventRoutes(scope, deps.events, deps.settings);
      registerActivationRoutes(scope, deps.activation);
      registerRehearsalTeamRoutes(scope, deps.rehearsal);
      registerBuilderRoutes(scope, {
        pool: deps.pool,
        ...deps.questCodes,
        settings: deps.settings,
      });
      registerRewardBuilderRoutes(scope, { pool: deps.pool, codeKey: deps.rewardCodeKey });
      registerChangeSetRoutes(scope, {
        pool: deps.pool,
        codeKey: deps.rewardCodeKey,
        settings: deps.settings,
      });
      registerSetupRoutes(scope, { pool: deps.pool });
      registerHeldPrizesTeamRoute(scope, { pool: deps.pool });
      registerAnalyticsTeamRoutes(scope, { pool: deps.pool });
      registerControlTeamRoutes(scope, createControlReader({ pool: deps.pool }), {
        pool: deps.pool,
      });
      registerInboxTeamRoutes(scope, { pool: deps.pool });
      registerReadinessTeamRoutes(scope, { pool: deps.pool });
      registerModerationRoutes(scope, { pool: deps.pool });
      registerAwardRoutes(scope, { pool: deps.pool });
      registerSubmissionTeamRoutes(scope, { pool: deps.pool, ranking: deps.ranking });
      registerTicketTeamRoutes(scope, { pool: deps.pool });
      registerPlayTeamRoutes(scope, { pool: deps.pool });
      registerCommunityTeamRoutes(scope, { pool: deps.pool, settings: deps.settings });
      registerSouvenirRoutes(scope, { pool: deps.pool });
      registerBoostTeamRoutes(scope, { pool: deps.pool, settings: deps.settings });
      registerAnnouncementTeamRoutes(scope, { pool: deps.pool });
      registerContentHoldTeamRoutes(scope, { pool: deps.pool });
      registerSessionTeamRoutes(scope, { pool: deps.pool });
      registerMapTeamRoutes(scope, { pool: deps.pool });
      registerSponsorTeamRoutes(scope, { pool: deps.pool });
      registerRatingTeamRoutes(scope, { pool: deps.pool });
      registerStreakTeamRoutes(scope, { pool: deps.pool });
      registerNfcTeamRoutes(scope, { pool: deps.pool });
      registerDeviceTeamRoutes(scope, deps.devices);
      registerScreenTeamRoutes(scope, { pool: deps.pool });
      registerCheersTeamRoutes(scope, { pool: deps.pool });
      registerPushDefaultsTeamRoutes(scope, { pool: deps.pool });
      registerFlagRoutes(scope, { pool: deps.pool });
      registerResultsTeamRoutes(scope, { pool: deps.pool });
      registerQuestItemRoutes(scope, { pool: deps.pool });
      registerOperatorRoutes(scope, deps.operators);
      registerOperatorActivityRoutes(scope, { pool: deps.pool });
      registerJoinSetupRoutes(scope, { pool: deps.pool });
      registerAudienceRoutes(scope, { pool: deps.pool });
      registerInvitationTeamRoutes(scope, deps.invitations);
    },
    { prefix: ORGANIZER_PREFIX },
  );
}
