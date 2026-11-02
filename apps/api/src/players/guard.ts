import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { eventUnavailable, legalAcceptanceRequired, unauthenticated } from "#src/auth/http-errors";
import type { SuspendedSet } from "#src/events/suspended-set";
import { PLAYER_GUARD } from "#src/route-access";

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

/** The active player a bearer token belongs to, or undefined (expired, revoked, banned, unknown). */
export async function playerOfToken(pool: Pool, token: string): Promise<string | undefined> {
  const hash = hashOf(token);
  const { rows } = await pool.query<{ owner: string | null }>(
    "SELECT player_session_owner($1) AS owner",
    [hash],
  );
  return rows[0]?.owner ?? undefined;
}

/**
 * What a player can still do while a new version of the terms or privacy policy waits (ADR-446): accept it, leave the
 * account (deletion code, this phone's push device). Every other write answers 403 until the player accepts.
 */
const OPEN_WHILE_UNACCEPTED = new Set([
  "POST /v1/me/acceptances",
  "POST /v1/me/deletion/code",
  "DELETE /v1/me/push-device",
]);

async function refuseUnacceptedWrite(
  request: FastifyRequest,
  pool: Pool,
  playerId: string,
): Promise<void> {
  const { method } = request;
  if (
    method === "GET" ||
    method === "HEAD" ||
    method === "OPTIONS" ||
    OPEN_WHILE_UNACCEPTED.has(`${method} ${request.routeOptions.url ?? ""}`)
  ) {
    return;
  }
  const { rows } = await pool.query<{ held: boolean }>("SELECT player_legal_held($1) AS held", [
    playerId,
  ]);
  if (rows[0]?.held === true) {
    throw legalAcceptanceRequired();
  }
}

/**
 * The check behind every route marked `player`: an `Authorization: Bearer` token of a live session of an active player,
 * else 401. It sets the player and the idempotency principal before the conventions read them. Registering it is what
 * allows player routes at all (route-access.ts). A route of a suspended event (`:eventId`) then answers 404
 * `event_unavailable` (T-701, FR-1607): players learn only that the event is unavailable, never why. A write by a
 * player who has not accepted the terms and privacy policy in force answers 403 `legal_acceptance_required` (T-707).
 */
export function registerPlayerGuard(
  app: FastifyInstance,
  pool: Pool,
  suspended: SuspendedSet,
): void {
  app.decorate(PLAYER_GUARD, true);
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config.access !== "player") {
      return;
    }
    reply.header("cache-control", "no-store");
    const token = BEARER.exec(request.headers.authorization ?? "")?.[1];
    const player = token === undefined ? undefined : await playerOfToken(pool, token);
    if (player === undefined) {
      throw unauthenticated();
    }
    request.player = { id: player };
    request.principalId = `player:${player}`;
    const { eventId } = request.params as { eventId?: unknown };
    if (typeof eventId === "string" && (await suspended.has(eventId))) {
      throw eventUnavailable();
    }
    await refuseUnacceptedWrite(request, pool, player);
  });
}
