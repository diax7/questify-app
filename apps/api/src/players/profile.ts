import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  profilePatchSchema,
  type Equipment,
  type ProfileItem,
  TUNING,
  checkUsername,
  playerDocuments,
  signupDocuments,
  type Avatar,
  type DailyStreak,
  type PlayerDocument,
  type PlayerDocumentId,
} from "@questify/shared";
import { z } from "zod";
import {
  invalidUsername,
  playerAcceptanceRequired,
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
import { itemRefusal, readEquipment } from "#src/players/items";
import { readOwnDailyStreak } from "#src/streaks/streaks";
import { readUnreadTickets } from "#src/tickets/tickets";

export type ProfileDeps = Readonly<{ pool: Pool; settings: SettingsService }>;

/**
 * What a player sees of their own profile: no birth year, and their phone and email only masked (the app shows which
 * is missing, FR-139, FR-1817, without the profile carrying contacts).
 */
export type MyProfile = Readonly<{
  id: string;
  username: string;
  avatar: Avatar;
  equipment: Equipment;
  usernameChange: Readonly<{ allowed: boolean; nextChangeAt: string | null }>;
  /**
   * The sign-up documents (terms, privacy) whose version in force the player has not accepted (the app asks on launch),
   * and whether they accepted the guidelines in force (the first submission needs it, FR-1706).
   */
  legal: Readonly<{ toAccept: readonly PlayerDocumentId[]; guidelinesAccepted: boolean }>;
  identifiers: Readonly<{ phone: string | null; email: string | null }>;
  /** The lifetime Questify level (T-401, FR-416, FR-706): the bar runs from `levelFrom` to `nextLevelAt` (null at the top). */
  questify: QuestifyLevel;
  /** Answers to the player's requests not seen yet, in every queue (T-312): the profile tab's dot. */
  help: Readonly<{ unread: number }>;
  /** The player's gem balance (T-404): earned by playing, spent in the gem shop; never shown to anyone else. */
  gems: number;
  /** The Questify daily streak (T-405, FR-419): the owner's alone; null while the platform switch is off. */
  dailyStreak: DailyStreak | null;
}>;

export type QuestifyLevel = Readonly<{
  xp: number;
  level: number;
  levelFrom: number;
  nextLevelAt: number | null;
  title: Readonly<{ ar: string; en: string }>;
  nextReward: ProfileItem | null;
}>;

/** The caller's level through own_level (migration 0039); a player always has an XP row. */
async function readLevel(client: PoolClient): Promise<Omit<QuestifyLevel, "nextReward">> {
  const { rows } = await client.query<{
    xp: string;
    level: number;
    level_from: string;
    next_level_at: string | null;
    title_ar: string;
    title_en: string;
  }>("SELECT xp, level, level_from, next_level_at, title_ar, title_en FROM own_level(NULL)");
  const row = rows[0];
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard found this active player
  if (row === undefined) {
    throw unauthenticated();
  }
  return {
    xp: Number(row.xp),
    level: row.level,
    levelFrom: Number(row.level_from),
    nextLevelAt: row.next_level_at === null ? null : Number(row.next_level_at),
    title: { ar: row.title_ar, en: row.title_en },
  };
}

/** The caller's gem balance through own_gems (migration 0067); a player always has an XP row. */
async function readGems(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ gems: string | null }>("SELECT own_gems() AS gems");
  const gems = rows[0]?.gems;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard found this active player
  if (gems === null || gems === undefined) {
    throw unauthenticated();
  }
  return Number(gems);
}

/** A phone as its last four digits. */
export const maskPhone = (phone: string): string => `•••• ${phone.slice(-4)}`;

/** An email as its first character and its domain (a one-letter local part shows whole: the owner reads it). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

const patchBody = profilePatchSchema;

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

export async function readMe(deps: ProfileDeps, playerId: string): Promise<MyProfile> {
  const rules = await changeRules(deps.settings);
  return asPlayer(deps.pool, playerId, async (client) => {
    const { rows } = await client.query<{
      username: string;
      avatar: Avatar;
      next: Date | null;
      accepted: Record<string, string[]> | null;
      phone: string | null;
      email: string | null;
    }>(
      `SELECT p.username, p.avatar, username_next_change($2) AS next, pc.phone_e164 AS phone, pc.email,
              (SELECT jsonb_object_agg(document, versions) FROM (
                 SELECT document, jsonb_agg(version) AS versions FROM player_acceptance
                 WHERE player_id = $1 GROUP BY document) a) AS accepted
       FROM player p LEFT JOIN player_contact pc ON pc.player_id = p.id WHERE p.id = $1`,
      [playerId, rules.days],
    );
    const row = rows[0];
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard found this active player
    if (row === undefined) {
      throw unauthenticated();
    }
    const questify = await readLevel(client);
    const cosmetics = await readEquipment(client);
    const unread = await readUnreadTickets(client, null);
    const gems = await readGems(client);
    const dailyStreak = await readOwnDailyStreak(client);
    return {
      id: playerId,
      username: row.username,
      avatar: row.avatar,
      usernameChange: {
        allowed: rules.on && row.next === null,
        nextChangeAt: row.next?.toISOString() ?? null,
      },
      legal: legalOf(row.accepted ?? {}),
      identifiers: {
        phone: row.phone === null ? null : maskPhone(row.phone),
        email: row.email === null ? null : maskEmail(row.email),
      },
      questify: { ...questify, nextReward: cosmetics.next_reward },
      equipment: cosmetics.equipment,
      help: { unread },
      gems,
      dailyStreak,
    };
  });
}

/** What is left to accept, from the versions the player accepted of each document. */
function legalOf(accepted: Readonly<Record<string, readonly string[]>>): MyProfile["legal"] {
  const has = (id: PlayerDocumentId, version: string) => accepted[id]?.includes(version) === true;
  const missing = (documents: readonly PlayerDocument[]) =>
    documents
      .filter((document) => !has(document.id, document.version))
      .map((document) => document.id);
  return {
    toAccept: missing(signupDocuments()),
    guidelinesAccepted: !missing(playerDocuments()).includes("community_guidelines"),
  };
}

const VERSION = z.string().regex(/^[0-9]+(\.[0-9]+){0,2}$/);
const acceptBody = z
  .strictObject({
    terms: VERSION.optional(),
    privacy: VERSION.optional(),
    guidelines: VERSION.optional(),
  })
  .refine((body) => Object.keys(body).length > 0);

/**
 * Records the versions the player accepted now, all or nothing: every document sent must be the version in force, or
 * the answer names the versions in force. With the guidelines it is the submission step (FR-1706), else re-acceptance.
 */
async function acceptDocuments(
  deps: ProfileDeps,
  playerId: string,
  body: z.infer<typeof acceptBody>,
): Promise<void> {
  const sent = playerDocuments().filter((document) => body[document.field] !== undefined);
  if (sent.some((document) => body[document.field] !== document.version)) {
    throw playerAcceptanceRequired({
      documents: playerDocuments().map(({ id, version }) => ({ id, version })),
    });
  }
  const documents = JSON.stringify(sent.map(({ id, version }) => ({ document: id, version })));
  await asPlayer(deps.pool, playerId, (client) =>
    client.query("SELECT accept_player_documents($1, $2)", [
      documents,
      body.guidelines === undefined ? "reaccept" : "submission",
    ]),
  );
}

/** Renames the caller, or throws the refusal's HTTP error. */
async function renameMe(
  rules: Awaited<ReturnType<typeof changeRules>>,
  reply: FastifyReply,
  client: PoolClient,
  typed: string,
): Promise<void> {
  if (!rules.on) {
    throw usernameChangesOff();
  }
  const name = checkUsername(typed);
  if (!name.ok) {
    throw invalidUsername({ reason: name.reason });
  }
  const { outcome, next_change_at: next } = await (async () => {
    const { rows } = await client.query<{ outcome: string; next_change_at: Date | null }>(
      "SELECT * FROM rename_player($1, $2)",
      [name.username, rules.days],
    );
    // Stryker disable next-line OptionalChaining: rename_player always answers one row
    return rows[0] ?? { outcome: "unchanged", next_change_at: null };
  })();
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
  app.get("/v1/me", { config: { access: "player" } }, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return readMe(deps, own(request));
  });

  app.patch("/v1/me", { config: { access: "player" }, bodyLimit: 1024 }, async (request, reply) => {
    const playerId = own(request);
    const body = parse(patchBody, request.body);
    const rules = body.username === undefined ? null : await changeRules(deps.settings);
    try {
      await asPlayer(deps.pool, playerId, async (client) => {
        // The setter locks the player, validates every slot and changes equipment in this transaction.
        await client.query("SELECT equip_player($1)", [JSON.stringify(body)]);
        if (body.username !== undefined && rules !== null)
          await renameMe(rules, reply, client, body.username);
      });
    } catch (error) {
      itemRefusal(error);
    }
    return readMe(deps, playerId);
  });

  // FR-1705's re-acceptance after a new version, and the guidelines before a first submission (FR-1706).
  app.post(
    "/v1/me/acceptances",
    { config: { access: "player" }, bodyLimit: 1024 },
    async (request) => {
      const playerId = own(request);
      await acceptDocuments(deps, playerId, parse(acceptBody, request.body));
      return readMe(deps, playerId);
    },
  );
}
