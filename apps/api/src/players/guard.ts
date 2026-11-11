import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { eventUnavailable, legalAcceptanceRequired, unauthenticated } from "#src/auth/http-errors";
import type { SuspendedSet } from "#src/events/suspended-set";
import { eventOfRef, registerMaintenanceGate, type ParamKind } from "#src/maintenance/gate";
import { PLAYER_GUARD } from "#src/route-access";
import type { SettingsService } from "#src/settings/service";

/** A bearer token is 32 random bytes in base64url (T-107 issues them, as staff sessions are made). */
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** The hash player_session stores for a bearer token. */
const hashOf = (token: string): Buffer => createHash("sha256").update(token).digest();

/**
 * The stored hash of the request's own access token (the `Authorization: Bearer` header), or undefined when there is
 * none: a door that acts on this sign-in (the push device, T-501) finds its session by it.
 */
export function sessionHashOf(authorization: unknown): Buffer | undefined {
  const token = typeof authorization === "string" ? BEARER.exec(authorization)?.[1] : undefined;
  return token === undefined ? undefined : hashOf(token);
}

/**
 * What a player can still do while a new version of the terms or privacy policy waits (ADR-446): accept it, leave the
 * account (deletion code, this phone's push device), or sign other devices out (ADR-714). Every other write answers 403 until the player accepts.
 */
const OPEN_WHILE_UNACCEPTED = new Set([
  "POST /v1/me/acceptances",
  "POST /v1/me/deletion/code",
  "DELETE /v1/me/push-device",
  // Signing a lost phone out is a safety action (ADR-714).
  "POST /v1/me/devices/:id/end",
  "POST /v1/me/devices/end-others",
  "POST /v1/me/reauth/code",
  "POST /v1/me/reauth/verify",
]);

/** Whether the legal hold applies to this request: a write that is not one of the open doors. */
function heldWrite(request: FastifyRequest): boolean {
  const { method } = request;
  return !(
    method === "GET" ||
    method === "HEAD" ||
    method === "OPTIONS" ||
    OPEN_WHILE_UNACCEPTED.has(`${method} ${request.routeOptions.url ?? ""}`)
  );
}

/**
 * The route params that name an object of one event, with the kind `play_event_id` (migration 0190) finds that event
 * by: a route without `:eventId` that carries one of these is walled by the object's event (FR-1607, plan
 * 2026-11-11-audit-hardening-core). `test/security/suspension-doors.int.test.ts` walks every player route and fails on a
 * param that is on neither this map nor its open list.
 */
export const DERIVED_PARAMS: Readonly<Record<string, ParamKind>> = {
  questId: "quest",
  stepId: "step",
  categoryId: "category",
  rewardId: "reward",
  saleId: "desk_sale",
  roundId: "game_round",
  sessionId: "session",
  passId: "meet_pass",
  redemptionId: "redemption",
};

/**
 * The routes with a derived param that stay open while their event is suspended: declining or withdrawing an offer and
 * cancelling or declining a reservation give points back or end a hand-over, so a player is never stuck holding them.
 */
export const OPEN_WHILE_SUSPENDED: ReadonlySet<string> = new Set([
  "POST /v1/desk-sales/:saleId/decline",
  "POST /v1/operator/desk/sales/:saleId/withdraw",
  "POST /v1/redemptions/:redemptionId/cancel",
  "POST /v1/redemptions/:redemptionId/decline",
  "POST /v1/operator/redemptions/:redemptionId/cancel",
]);

/**
 * Whether the request names an event that is suspended: by `:eventId`, else (while some event is suspended) by the
 * first derived param, looked up once per request (`eventOfRef`). An unknown id names nothing: the route answers its own
 * 404.
 */
async function namesSuspendedEvent(
  request: FastifyRequest,
  pool: Pool,
  suspended: SuspendedSet,
): Promise<boolean> {
  const params = request.params as Record<string, unknown>;
  const { eventId } = params;
  if (typeof eventId === "string") {
    return suspended.has(eventId.toLowerCase());
  }
  const ref = derivedRef(request, params);
  if (ref === undefined || !(await suspended.any())) {
    return false;
  }
  const event = await eventOfRef(pool, ref, request);
  return event !== undefined && (await suspended.has(event));
}

/** The object a route without `:eventId` names by its first derived param, unless the route is open while suspended. */
function derivedRef(
  request: FastifyRequest,
  params: Record<string, unknown>,
): Readonly<{ kind: ParamKind; ref: string }> | undefined {
  if (OPEN_WHILE_SUSPENDED.has(`${request.method} ${request.routeOptions.url ?? ""}`)) {
    return undefined;
  }
  for (const [name, ref] of Object.entries(params)) {
    const kind = Object.hasOwn(DERIVED_PARAMS, name) ? DERIVED_PARAMS[name] : undefined;
    if (kind !== undefined && typeof ref === "string") {
      return { kind, ref };
    }
  }
  return undefined;
}

type Gate = Readonly<{ player: string | undefined; held: boolean }>;

/**
 * The active player a bearer token belongs to (undefined when expired, revoked, reset, banned or unknown) and, for a
 * write, whether a new terms or privacy version holds them: one call, `player_request_gate` (ADR-672).
 */
async function gateOf(pool: Pool, token: string, write: boolean): Promise<Gate> {
  const { rows } = await pool.query<{ player_id: string | null; held: boolean | null }>(
    "SELECT player_id, held FROM player_request_gate($1, $2)",
    [hashOf(token), write],
  );
  const row = rows[0];
  return { player: row?.player_id ?? undefined, held: row?.held === true };
}

/** The request's player and whether its write is held, else 401 (no token, or no live session of an active player). */
async function gateOfRequest(
  request: FastifyRequest,
  pool: Pool,
): Promise<Readonly<{ player: string; held: boolean }>> {
  const token = BEARER.exec(request.headers.authorization ?? "")?.[1];
  const gate = token === undefined ? undefined : await gateOf(pool, token, heldWrite(request));
  if (gate?.player === undefined) {
    throw unauthenticated();
  }
  return { player: gate.player, held: gate.held };
}

/**
 * The check behind every route marked `player`: an `Authorization: Bearer` token of a live session of an active player,
 * else 401. It sets the player and the idempotency principal before the conventions read them. Registering it is what
 * allows player routes at all (route-access.ts). A route of a suspended event (`:eventId`, or an object of it named
 * by a `DERIVED_PARAMS` param) then answers 404 `event_unavailable` (T-701, FR-1607): players learn only that the event
 * is unavailable, never why. A write by a
 * player who has not accepted the terms and privacy policy in force answers 403 `legal_acceptance_required` (T-707).
 * While Questify paused play, the play doors then answer 503 `maintenance` (T-703b, `registerMaintenanceGate`).
 */
export function registerPlayerGuard(
  app: FastifyInstance,
  pool: Pool,
  suspended: SuspendedSet,
  settings: Pick<SettingsService, "platform">,
): void {
  app.decorate(PLAYER_GUARD, true);
  registerMaintenanceGate(app, { pool, settings });
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config.access !== "player") {
      return;
    }
    reply.header("cache-control", "no-store");
    const { player, held } = await gateOfRequest(request, pool);
    request.player = { id: player };
    request.principalId = `player:${player}`;
    if (await namesSuspendedEvent(request, pool, suspended)) {
      throw eventUnavailable();
    }
    if (held) {
      throw legalAcceptanceRequired();
    }
  });
}
