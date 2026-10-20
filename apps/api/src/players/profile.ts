import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import { AVATARS, TUNING, checkUsername, type Avatar } from "@questify/shared";
import { z } from "zod";
import {
  invalidUsername,
  unauthenticated,
  usernameBlocked,
  usernameChangesOff,
  usernameTaken,
  usernameTooSoon,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { SettingsService } from "#src/settings/service";

export type ProfileDeps = Readonly<{ pool: Pool; settings: SettingsService }>;

/** What a player sees of their own profile; no contact and no birth year (the app never shows them back). */
export type MyProfile = Readonly<{
  id: string;
  username: string;
  avatar: Avatar;
  usernameChange: Readonly<{ allowed: boolean; nextChangeAt: string | null }>;
}>;

const patchBody = z
  .strictObject({
    username: z.string().min(1).max(120).optional(),
    avatar: z.enum(AVATARS).optional(),
  })
  .refine((body) => body.username !== undefined || body.avatar !== undefined);

/** The platform's username-change switch and the days between changes (FR-1702, FR-705). */
async function changeRules(settings: SettingsService): Promise<{ on: boolean; days: number }> {
  const composed = await settings.forEvent(undefined);
  const fallback = TUNING["usernameChangeDays"]?.default ?? 30;
  // Stryker disable next-line ConditionalExpression: the platform level always composes; the fallback is defence in depth
  if (composed.kind !== "ok") {
    return { on: false, days: fallback };
  }
  return {
    on: composed.config.features["usernameChanges"]?.enabled === true,
    days: composed.config.tuning["usernameChangeDays"] ?? fallback,
  };
}

const asPlayer = <T>(pool: Pool, playerId: string, work: (client: PoolClient) => Promise<T>) =>
  withConnection(pool, (client) => withRequestContext(client, { playerId }, () => work(client)));

async function readMe(deps: ProfileDeps, playerId: string): Promise<MyProfile> {
  const rules = await changeRules(deps.settings);
  return asPlayer(deps.pool, playerId, async (client) => {
    const { rows } = await client.query<{
      username: string;
      avatar: Avatar;
      next: Date | null;
    }>(
      "SELECT p.username, p.avatar, username_next_change($2) AS next FROM player p WHERE p.id = $1",
      [playerId, rules.days],
    );
    const row = rows[0];
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard found this active player
    if (row === undefined) {
      throw unauthenticated();
    }
    return {
      id: playerId,
      username: row.username,
      avatar: row.avatar,
      usernameChange: {
        allowed: rules.on && row.next === null,
        nextChangeAt: row.next?.toISOString() ?? null,
      },
    };
  });
}

/** Renames the caller, or throws the refusal's HTTP error. */
async function renameMe(
  deps: ProfileDeps,
  reply: FastifyReply,
  playerId: string,
  typed: string,
): Promise<void> {
  const rules = await changeRules(deps.settings);
  if (!rules.on) {
    throw usernameChangesOff();
  }
  const name = checkUsername(typed);
  if (!name.ok) {
    throw invalidUsername({ reason: name.reason });
  }
  const { outcome, next_change_at: next } = await asPlayer(deps.pool, playerId, async (client) => {
    const { rows } = await client.query<{ outcome: string; next_change_at: Date | null }>(
      "SELECT * FROM rename_player($1, $2)",
      [name.username, rules.days],
    );
    // Stryker disable next-line OptionalChaining: rename_player always answers one row
    return rows[0] ?? { outcome: "unchanged", next_change_at: null };
  });
  switch (outcome) {
    case "too_soon": {
      const retryAfter = Math.max(1, Math.ceil(((next?.getTime() ?? 0) - Date.now()) / 1000));
      reply.header("retry-after", String(retryAfter));
      throw usernameTooSoon({ nextChangeAt: next?.toISOString() ?? null });
    }
    case "username_blocked":
      throw usernameBlocked();
    case "username_taken":
      throw usernameTaken();
  }
}

/** The caller's own player id. */
const own = (request: { player?: { id: string } | undefined }): string => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) {
    throw unauthenticated();
  }
  return request.player.id;
};

/**
 * `GET /v1/me` and `PATCH /v1/me` (T-109; FR-117, FR-704, FR-705, FR-1701, FR-1702): the player's own profile. The
 * avatar changes freely among Questify's six; the username only while the platform allows changes and not more often
 * than its tuned days, through `rename_player` (the word lists and the history live in the database).
 */
export function registerProfileRoutes(app: FastifyInstance, deps: ProfileDeps): void {
  app.get("/v1/me", { config: { access: "player" } }, async (request) =>
    readMe(deps, own(request)),
  );

  app.patch("/v1/me", { config: { access: "player" }, bodyLimit: 1024 }, async (request, reply) => {
    const playerId = own(request);
    const body = parse(patchBody, request.body);
    if (body.username !== undefined) {
      await renameMe(deps, reply, playerId, body.username);
    }
    if (body.avatar !== undefined) {
      const avatar = body.avatar;
      await asPlayer(deps.pool, playerId, (client) =>
        client.query("UPDATE player SET avatar = $2 WHERE id = $1", [playerId, avatar]),
      );
    }
    return readMe(deps, playerId);
  });
}
