import {
  ledgerPageSchema,
  playerRecordAnswerSchema,
  playerSearchSchema,
  revealedContactsSchema,
  type LedgerLine,
  type PlayerRecordAnswer,
  type PlayerSearchBy,
  type PlayerSearchRow,
  type RevealedContacts,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import {
  invalidPlayerSearch,
  invalidUsername,
  usernameBlocked,
  usernameTaken,
  usernameUnchanged,
} from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { isPlausibleEmail, normalizeEmail } from "#src/auth/normalize";
import { BUCKETS } from "#src/auth/throttle";
import { door, type Admin } from "#src/console/doors";
import { normalizeSaudiMobile } from "#src/players/phone";

/** Why an admin acts, as the door checks it: a code from the action's list and a note of 10 to 300 characters. */
export type ActionReason = Readonly<{ reasonCode: string; note: string }>;

/** The one answer a door gives. */
async function answerOf(client: PoolClient, sql: string, values: unknown[]): Promise<unknown> {
  const { rows } = await client.query<{ r: unknown }>(sql, values);
  return rows[0]?.r;
}

/**
 * The text searched for, in the form the database matches: a username as typed (NFKC, trimmed, at least 3
 * characters; the door folds it), a Saudi mobile as `+9665…`, an email lower-cased. Anything else is refused here, so
 * no malformed contact reaches the door's audit or the database.
 *
 * @throws HttpError invalid_player_search when the text cannot be that kind of search.
 */
export function searchKey(by: PlayerSearchBy, q: string): string {
  if (by === "phone") {
    const phone = normalizeSaudiMobile(q);
    if (phone === undefined) {
      throw invalidPlayerSearch();
    }
    return phone;
  }
  if (by === "email") {
    const email = normalizeEmail(q);
    if (!isPlausibleEmail(email)) {
      throw invalidPlayerSearch();
    }
    return email;
  }
  const name = q.normalize("NFKC").trim();
  if ([...name].length < 3 || [...name].length > 30) {
    throw invalidPlayerSearch();
  }
  return name;
}

/**
 * Finds players by a username prefix or an exact phone or email (`console_player_search`, migration 0118). Contacts
 * come back masked; the door's audit entry names how the search was made and the ids shown, never the text.
 */
export function searchPlayers(
  pool: Pool,
  admin: Admin,
  query: Readonly<{ by: PlayerSearchBy; q: string }>,
  requestId: string,
): Promise<PlayerSearchRow[]> {
  const key = searchKey(query.by, query.q);
  return door(pool, admin, async (client) =>
    playerSearchSchema.parse(
      await answerOf(client, "SELECT console_player_search($1, $2, $3) AS r", [
        query.by,
        key,
        requestId,
      ]),
    ),
  );
}

/** One player's read-only record, audited by the door (`console_player_record`). */
export function readPlayerRecord(
  pool: Pool,
  admin: Admin,
  playerId: string,
  requestId: string,
): Promise<PlayerRecordAnswer> {
  return door(pool, admin, async (client) =>
    playerRecordAnswerSchema.parse(
      await answerOf(client, "SELECT console_player_record($1, $2) AS r", [playerId, requestId]),
    ),
  );
}

/** One page of a player's points record, newest first, all events or one; audited by the door. */
export function readPlayerLedger(
  pool: Pool,
  admin: Admin,
  query: Readonly<{ playerId: string; eventId: string | null; before: number | null }>,
  requestId: string,
): Promise<LedgerLine[]> {
  return door(pool, admin, async (client) =>
    ledgerPageSchema.parse(
      await answerOf(client, "SELECT console_player_ledger($1, $2, $3, $4) AS r", [
        query.playerId,
        query.eventId,
        query.before,
        requestId,
      ]),
    ),
  );
}

/** The player's full phone and email, with an action row and an audit entry on every call (ADR-422). */
export function revealContacts(
  pool: Pool,
  admin: Admin,
  input: ActionReason & Readonly<{ playerId: string }>,
  requestId: string,
): Promise<RevealedContacts> {
  return door(pool, admin, async (client) =>
    revealedContactsSchema.parse(
      await answerOf(client, "SELECT console_player_contact($1, $2, $3, $4) AS r", [
        input.playerId,
        input.reasonCode,
        input.note,
        requestId,
      ]),
    ),
  );
}

const RENAME_REFUSALS = {
  invalid: invalidUsername,
  unchanged: usernameUnchanged,
  username_blocked: usernameBlocked,
  username_taken: usernameTaken,
} as const;

/**
 * Changes a player's username for Questify (FR-1775, ADR-420): the player's own rules and lists, the old name retired,
 * the player told. The name is checked by the shared rules first (`checkUsername` in the route) and again by the door.
 *
 * @throws HttpError for a name the door refuses, and 404 for an unknown or erased player.
 */
export function renamePlayer(
  pool: Pool,
  admin: Admin,
  input: ActionReason & Readonly<{ playerId: string; username: string }>,
  requestId: string,
): Promise<string> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ outcome: string; action_id: string | null }>(
      "SELECT * FROM admin_rename_player($1, $2, $3, $4, $5)",
      [input.playerId, input.username, input.reasonCode, input.note, requestId],
    );
    const row = rows[0];
    if (row?.outcome === "renamed" && row.action_id !== null) {
      return row.action_id;
    }
    const refusal = RENAME_REFUSALS[row?.outcome as keyof typeof RENAME_REFUSALS];
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the door answers one of the outcomes
    if (refusal === undefined) {
      throw new Error("admin_rename_player gave an unknown outcome; check migration 0118");
    }
    throw refusal();
  });
}

/**
 * Ends every way into a player's account (FR-1775, ADR-421): the door ends the tokens, the open codes and the push
 * devices and sets the cutoff; then, in the same transaction, the code and failure throttles of the account's own
 * contacts are cleared (keyed hashes only this server can compute), so a locked-out player can ask for a code at once.
 * The contacts are read here and never leave this function. Address and install throttles stay.
 */
export function resetSignIn(
  pool: Pool,
  keys: Pick<AuthKeys, "contactThrottleKey">,
  admin: Admin,
  input: ActionReason & Readonly<{ playerId: string }>,
  requestId: string,
): Promise<Readonly<{ actionId: string; endedSignIns: number }>> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ action_id: string; ended: number }>(
      "SELECT * FROM admin_reset_player_sign_in($1, $2, $3, $4)",
      [input.playerId, input.reasonCode, input.note, requestId],
    );
    const row = rows[0];
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the door answers one row or raises
    if (row === undefined) {
      throw new Error("admin_reset_player_sign_in answered no row; check migration 0118");
    }
    const contacts = await client.query<{ phone_e164: string | null; email: string | null }>(
      "SELECT phone_e164, email FROM player_contact WHERE player_id = $1",
      [input.playerId],
    );
    const throttleKeys = contacts.rows
      .flatMap((contact) => [contact.phone_e164, contact.email])
      .filter((value): value is string => value !== null)
      .map((value) => keys.contactThrottleKey(value));
    if (throttleKeys.length > 0) {
      await client.query("DELETE FROM auth_throttle WHERE bucket = ANY ($1) AND key = ANY ($2)", [
        [BUCKETS.playerCodeContact, BUCKETS.playerFailContact],
        throttleKeys,
      ]);
    }
    return { actionId: row.action_id, endedSignIns: row.ended };
  });
}
