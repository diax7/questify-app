import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { REGISTRIES, isGatedFeature } from "@questify/shared";
import { z } from "zod";
import { checkAddons, checkLimit, type Refusal } from "#src/activation/activation";
import type { Activation } from "#src/activation/service";
import {
  activationIncomplete,
  alreadyActivated,
  invalidLimit,
  noPendingRequest,
  notActivated,
  notFound,
  unknownAddon,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import type { Sessions } from "#src/auth/session";
import { checkOrigin, requireSession } from "#src/auth/staff-guard";
import type { PublicAccount } from "#src/auth/staff-store";
import { registerConsoleDailyRoutes } from "#src/daily/admin-routes";
import type { HttpError } from "#src/http-error";
import { organizerContextOf } from "#src/organizers/context";
import { registerConsoleQuestifyRoutes } from "#src/questify/admin-routes";
import { ADMIN_PREFIX } from "#src/route-access";
import type { SettingsService } from "#src/settings/service";
import { registerConsoleTicketRoutes, type ConsoleTicketDeps } from "#src/tickets/console-routes";

const BODY_LIMIT = 8192;
const eventParams = z.object({ eventId: z.uuid() });
const addonParams = z.object({ eventId: z.uuid(), feature: z.string().min(1).max(64) });
const limitBody = z.strictObject({
  mode: z.enum(["none", "soft", "hard"]),
  value: z.number().nullable().optional(),
});
const activateBody = z.strictObject({
  limit: limitBody,
  addons: z.array(z.string().min(1).max(64)).max(50),
});
const rejectBody = z.strictObject({ note: z.string().trim().min(1).max(500) });
const lookupQuery = z.strictObject({ code: z.string().regex(/^[A-Za-z0-9]{4,12}$/) });

const member = { config: { access: "member" }, bodyLimit: BODY_LIMIT } as const;
const owner = { config: { access: "owner" }, bodyLimit: BODY_LIMIT } as const;
const admin = { config: { access: "admin" }, bodyLimit: BODY_LIMIT } as const;

/** Every refusal as an HTTP answer; `conflict` means what the route says it means. */
function refuse(refusal: Refusal, conflict: () => HttpError): never {
  switch (refusal.kind) {
    case "invalid":
      throw activationIncomplete({ field: refusal.field });
    case "conflict":
      throw conflict();
    default:
      // forbidden and not_found: the caller cannot reach such an event, which looks the same as none.
      throw notFound();
  }
}

/**
 * The owner's side (FR-1019, FR-1020), inside the organizer scope: anyone on the team reads where the event stands;
 * only the owner requests or withdraws. Nothing here holds a price or charges anything.
 */
export function registerActivationRoutes(scope: FastifyInstance, activation: Activation): void {
  scope.get("/events/:eventId/activation", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const view = await activation.view(organizerContextOf(request), eventId);
    if (view === undefined) {
      throw notFound();
    }
    return { activation: view };
  });

  scope.post("/events/:eventId/activation", owner, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const result = await activation.request(
      organizerContextOf(request),
      eventId,
      callerOf(request),
    );
    if ("requestedAt" in result) {
      return reply
        .code(result.kind === "requested" ? 201 : 200)
        .send({ requestedAt: result.requestedAt });
    }
    return refuse(result, alreadyActivated);
  });

  scope.delete("/events/:eventId/activation", owner, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const result = await activation.withdraw(
      organizerContextOf(request),
      eventId,
      callerOf(request),
    );
    if (result.kind === "withdrawn") {
      return reply.code(204).send();
    }
    // Nothing to withdraw looks like a missing request.
    throw notFound();
  });
}

export type ConsoleRoutesDeps = Readonly<{
  activation: Activation;
  settings: SettingsService;
  sessions: Sessions;
  dashboardOrigin: string;
  /** Questify's ticket queue (T-312), behind the same hook. */
  tickets: ConsoleTicketDeps;
  /** The Questify quests page (T-403b), behind the same hook. */
  questify: Readonly<{ pool: Pool }>;
}>;

/** The admin of a request that passed the console hook. */
function adminOf(request: FastifyRequest): PublicAccount {
  const account = request.staff?.account;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (account === undefined) {
    throw notFound();
  }
  return account;
}

function registerConsoleWrites(scope: FastifyInstance, deps: ConsoleRoutesDeps): void {
  // A double click must not activate twice with different answers: the Idempotency-Key replays the first.
  scope.post(
    "/events/:eventId/activate",
    { ...admin, config: { ...admin.config, idempotent: true } },
    async (request) => {
      const { eventId } = parse(eventParams, request.params);
      const body = parse(activateBody, request.body);
      const limit = checkLimit(body.limit);
      if (limit === undefined) {
        throw invalidLimit();
      }
      const addons = checkAddons(body.addons, REGISTRIES);
      if (!addons.ok) {
        throw unknownAddon({ feature: addons.unknown });
      }
      const result = await deps.activation.activate(
        adminOf(request),
        eventId,
        { limit, addons: addons.addons },
        callerOf(request),
      );
      if (result.kind !== "done") {
        refuse(result, alreadyActivated);
      }
      const view = await deps.activation.consoleEvent(adminOf(request), eventId);
      return { event: view };
    },
  );

  scope.post("/events/:eventId/reject", admin, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const { note } = parse(rejectBody, request.body);
    const result = await deps.activation.reject(adminOf(request), eventId, note, callerOf(request));
    if (result.kind !== "done") {
      refuse(result, noPendingRequest);
    }
    return reply.code(204).send();
  });

  scope.put("/events/:eventId/limit", admin, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const limit = checkLimit(parse(limitBody, request.body));
    if (limit === undefined) {
      throw invalidLimit();
    }
    const result = await deps.activation.setLimit(
      adminOf(request),
      eventId,
      limit,
      callerOf(request),
    );
    if (result.kind !== "done") {
      refuse(result, notActivated);
    }
    return { limit };
  });

  // Add-ons after activation (FR-1729): the settings service writes and audits them and clears its cache.
  scope.put("/events/:eventId/addons/:feature", admin, async (request, reply) => {
    const { eventId, feature } = parse(addonParams, request.params);
    if (!isGatedFeature(REGISTRIES, feature)) {
      throw unknownAddon({ feature });
    }
    const saved = await deps.settings.unlockFeature(adminOf(request), eventId, feature, {
      requestId: request.id,
    });
    if (!saved.ok) {
      throw notFound();
    }
    return reply.code(204).send();
  });

  scope.delete("/events/:eventId/addons/:feature", admin, async (request, reply) => {
    const { eventId, feature } = parse(addonParams, request.params);
    const saved = await deps.settings.lockFeature(adminOf(request), eventId, feature, {
      requestId: request.id,
    });
    if (!saved.ok) {
      throw notFound();
    }
    return reply.code(204).send();
  });
}

/**
 * The console's activation routes (FR-1021, FR-1402), all under /v1/admin/. The hook runs the staff checks, then
 * answers 404 to anyone who is not an active platform admin, so the console is not advertised. The database checks the
 * admin again inside every definer (`app_admin_id`, migration 0027).
 */
export function registerConsoleRoutes(app: FastifyInstance, deps: ConsoleRoutesDeps): void {
  app.register(
    async (scope) => {
      scope.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "no-store");
        checkOrigin(request, deps.dashboardOrigin, true);
        await requireSession(request, reply, deps.sessions);
        const account = request.staff?.account;
        if (account?.platformRole !== "admin" || account.status !== "active") {
          throw notFound();
        }
      });

      scope.get("/activation-requests", admin, async (request) => ({
        requests: await deps.activation.queue(adminOf(request)),
      }));

      scope.get("/events", admin, async (request) => {
        const { code } = parse(lookupQuery, request.query);
        const eventId = await deps.activation.findByCode(adminOf(request), code);
        if (eventId === undefined) {
          throw notFound();
        }
        return { eventId };
      });

      scope.get("/events/:eventId", admin, async (request) => {
        const { eventId } = parse(eventParams, request.params);
        const view = await deps.activation.consoleEvent(adminOf(request), eventId);
        if (view === undefined) {
          throw notFound();
        }
        return {
          event: view,
          availableAddons: Object.keys(REGISTRIES.features)
            .filter((feature) => isGatedFeature(REGISTRIES, feature))
            .toSorted(),
        };
      });

      registerConsoleWrites(scope, deps);
      registerConsoleTicketRoutes(scope, deps.tickets);
      registerConsoleQuestifyRoutes(scope, deps.questify);
      registerConsoleDailyRoutes(scope, deps.questify);
    },
    { prefix: ADMIN_PREFIX.slice(0, -1) },
  );
}
