import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { unauthenticated } from "#src/auth/http-errors";
import { PLAYER_GUARD } from "#src/route-access";

/** A bearer token is 32 random bytes in base64url (T-107 issues them, as staff sessions are made). */
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** The active player a bearer token belongs to, or undefined (expired, revoked, banned, unknown). */
export async function playerOfToken(pool: Pool, token: string): Promise<string | undefined> {
  const hash = createHash("sha256").update(token).digest();
  const { rows } = await pool.query<{ owner: string | null }>(
    "SELECT player_session_owner($1) AS owner",
    [hash],
  );
  return rows[0]?.owner ?? undefined;
}

/**
 * The check behind every route marked `player`: an `Authorization: Bearer` token of a live session of an active player,
 * else 401. It sets the player and the idempotency principal before the conventions read them. Registering it is what
 * allows player routes at all (route-access.ts).
 */
export function registerPlayerGuard(app: FastifyInstance, pool: Pool): void {
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
  });
}
