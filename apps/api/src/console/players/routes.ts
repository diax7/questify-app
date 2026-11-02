import {
  PLAYER_LEDGER_PAGE,
  PLAYER_NOTE_MAX,
  PLAYER_SEARCH_BY,
  checkUsername,
  isActionReason,
  isUsableActionNote,
  type PlayerActionKind,
} from "@questify/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { invalidPlayerAction, invalidUsername, notFound } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import {
  readPlayerLedger,
  readPlayerRecord,
  renamePlayer,
  resetSignIn,
  revealContacts,
  searchPlayers,
  type ActionReason,
} from "#src/console/players/doors";
import { holdBack, type DeviceLimit } from "#src/devices/limits";

const BODY_LIMIT = 8192;
const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
/**
 * Search and the contact reveal answer personal data: POST (the text stays out of every URL and log) but never
 * idempotent, so no answer is kept in the idempotency store or replayed without a fresh audit entry (plan review).
 */
const personalRead = { config: { access: "admin" }, bodyLimit: BODY_LIMIT } as const;
const change = { config: { access: "admin", idempotent: true }, bodyLimit: BODY_LIMIT } as const;

/** 30 searches a minute per admin. */
export const CONSOLE_PLAYER_SEARCH_LIMIT = {
  bucket: BUCKETS.consolePlayerSearch,
  max: 30,
  windowSeconds: 60,
} as const satisfies DeviceLimit;
/** 120 record and points-record reads a minute per admin. */
export const CONSOLE_PLAYER_READ_LIMIT = {
  bucket: BUCKETS.consolePlayerRead,
  max: 120,
  windowSeconds: 60,
} as const satisfies DeviceLimit;
/** 20 contact reveals an hour per admin. */
export const CONSOLE_PLAYER_CONTACT_LIMIT = {
  bucket: BUCKETS.consolePlayerContact,
  max: 20,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;
/** 30 renames and sign-in resets an hour per admin, together. */
export const CONSOLE_PLAYER_CHANGE_LIMIT = {
  bucket: BUCKETS.consolePlayerChange,
  max: 30,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;

const playerParams = z.object({ playerId: z.uuid() });
const searchBody = z.strictObject({
  by: z.enum(PLAYER_SEARCH_BY),
  q: z.string().min(1).max(254),
});
const ledgerQuery = z.strictObject({
  eventId: z.uuid().optional(),
  before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});
const reasonFields = {
  reasonCode: z.string().max(32),
  note: z.string().max(PLAYER_NOTE_MAX * 4),
};
const reasonBody = z.strictObject(reasonFields);
const renameBody = z.strictObject({ ...reasonFields, username: z.string().max(120) });

export type ConsolePlayerDeps = Readonly<{
  pool: Pool;
  keys: Pick<AuthKeys, "userKey" | "contactThrottleKey">;
}>;

/** The admin of a request that passed the console hook (activation/routes.ts). */
function adminOf(request: FastifyRequest): { id: string } {
  const account = request.staff?.account;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (account === undefined) {
    throw notFound();
  }
  return { id: account.id };
}

export async function throttled(
  deps: ConsolePlayerDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  limit: DeviceLimit,
): Promise<{ id: string }> {
  const who = adminOf(request);
  await holdBack(
    deps.pool,
    [{ limit, key: deps.keys.userKey(`${limit.bucket}:${who.id}`) }],
    true,
    reply,
    true,
  );
  return who;
}

/**
 * The reason of an action, checked against the action's list and the note rules before the door checks them again.
 *
 * @throws HttpError invalid_player_action for an unknown code or an unusable note.
 */
export function reasonOf(kind: PlayerActionKind, body: unknown): ActionReason {
  const { reasonCode, note } = parse(reasonBody, body);
  if (!isActionReason(kind, reasonCode)) {
    throw invalidPlayerAction();
  }
  if (!isUsableActionNote(note)) {
    throw invalidPlayerAction();
  }
  return { reasonCode, note: note.trim() };
}

function registerPlayerChanges(scope: FastifyInstance, deps: ConsolePlayerDeps): void {
  scope.post("/players/:playerId/contact", personalRead, async (request, reply) => {
    const { playerId } = parse(playerParams, request.params);
    const reason = reasonOf("contact_reveal", request.body);
    const who = await throttled(deps, request, reply, CONSOLE_PLAYER_CONTACT_LIMIT);
    return revealContacts(deps.pool, who, { ...reason, playerId }, request.id);
  });

  scope.post("/players/:playerId/username", change, async (request, reply) => {
    const { playerId } = parse(playerParams, request.params);
    const body = parse(renameBody, request.body);
    const reason = reasonOf("rename", { reasonCode: body.reasonCode, note: body.note });
    const checked = checkUsername(body.username);
    if (!checked.ok) {
      throw invalidUsername({ reason: checked.reason });
    }
    const who = await throttled(deps, request, reply, CONSOLE_PLAYER_CHANGE_LIMIT);
    const actionId = await renamePlayer(
      deps.pool,
      who,
      { ...reason, playerId, username: checked.username },
      request.id,
    );
    return { actionId, username: checked.username };
  });

  scope.post("/players/:playerId/reset-sign-in", change, async (request, reply) => {
    const { playerId } = parse(playerParams, request.params);
    const reason = reasonOf("reset_sign_in", request.body);
    const who = await throttled(deps, request, reply, CONSOLE_PLAYER_CHANGE_LIMIT);
    return resetSignIn(deps.pool, deps.keys, who, { ...reason, playerId }, request.id);
  });
}

/**
 * The console's player tools (T-704, FR-1774, FR-1775): find a player, the read-only record and points record, the
 * contact reveal, the admin rename and the sign-in reset. Registered inside the console scope, whose hook answers 404
 * to anyone but an active platform admin; every door re-reads the admin in the database and writes the audit entry.
 * No route sets or changes a contact, and nothing returns a code or a token: there is no account-takeover path.
 */
export function registerConsolePlayerRoutes(scope: FastifyInstance, deps: ConsolePlayerDeps): void {
  scope.post("/players/search", personalRead, async (request, reply) => {
    const query = parse(searchBody, request.body);
    const who = await throttled(deps, request, reply, CONSOLE_PLAYER_SEARCH_LIMIT);
    return { players: await searchPlayers(deps.pool, who, query, request.id) };
  });

  scope.get("/players/:playerId", read, async (request, reply) => {
    const { playerId } = parse(playerParams, request.params);
    const who = await throttled(deps, request, reply, CONSOLE_PLAYER_READ_LIMIT);
    return readPlayerRecord(deps.pool, who, playerId, request.id);
  });

  scope.get("/players/:playerId/ledger", read, async (request, reply) => {
    const { playerId } = parse(playerParams, request.params);
    const query = parse(ledgerQuery, request.query);
    const who = await throttled(deps, request, reply, CONSOLE_PLAYER_READ_LIMIT);
    const entries = await readPlayerLedger(
      deps.pool,
      who,
      { playerId, eventId: query.eventId ?? null, before: query.before ?? null },
      request.id,
    );
    return {
      entries,
      nextCursor: entries.length === PLAYER_LEDGER_PAGE ? (entries.at(-1)?.id ?? null) : null,
    };
  });

  registerPlayerChanges(scope, deps);
}
