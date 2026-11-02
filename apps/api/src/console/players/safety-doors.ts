import {
  retiredPageSchema,
  wordsPageSchema,
  type RetiredName,
  type WordLanguage,
  type WordMatch,
  type WordsPage,
} from "@questify/shared";
import type { Pool } from "pg";
import { alreadyBanned, notBanned, notFound, wordExists } from "#src/auth/http-errors";
import { door, type Admin } from "#src/console/doors";
import type { ActionReason } from "#src/console/players/doors";
import type { HttpError } from "#src/http-error";

type Standing = "ban" | "lift";

const STANDING_SQL: Readonly<Record<Standing, string>> = {
  ban: "SELECT * FROM admin_ban_player($1, $2, $3, $4)",
  lift: "SELECT * FROM admin_lift_ban($1, $2, $3, $4)",
};
const STANDING_REFUSALS: Readonly<Record<string, () => HttpError>> = {
  already_banned: alreadyBanned,
  not_banned: notBanned,
};

/**
 * Bans an account or lifts its ban (FR-1416, ADR-429): the door checks the admin and the reason, locks the player, ends
 * every way in on a ban, repairs the rankings and audits with ids only. Never automatic: these two doors are the only
 * writers of a standing.
 *
 * @throws HttpError already_banned or not_banned (409), 404 for an unknown or erased player, invalid_player_action.
 */
export function changeStanding(
  pool: Pool,
  admin: Admin,
  input: ActionReason & Readonly<{ playerId: string; to: Standing }>,
  requestId: string,
): Promise<string> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ outcome: string; action_id: string | null }>(
      STANDING_SQL[input.to],
      [input.playerId, input.reasonCode, input.note, requestId],
    );
    const row = rows[0];
    if (row?.action_id !== null && row?.action_id !== undefined) {
      return row.action_id;
    }
    const refusal = STANDING_REFUSALS[row?.outcome ?? ""];
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the doors answer one of the outcomes
    if (refusal === undefined) {
      throw new Error("the ban door gave an unknown outcome; check migration 0120");
    }
    throw refusal();
  });
}

export type WordFilter = Readonly<{
  q: string | null;
  language: WordLanguage | null;
  match: WordMatch | null;
  after: string | null;
}>;

/** One page of the username word lists, filtered (`console_words`). */
export function readWords(pool: Pool, admin: Admin, filter: WordFilter): Promise<WordsPage> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ r: unknown }>(
      "SELECT console_words($1, $2, $3, $4) AS r",
      [filter.q, filter.language, filter.match, filter.after],
    );
    return wordsPageSchema.parse(rows[0]?.r);
  });
}

/**
 * Adds a word to the lists; sign-up, rename and text marking read it at once. The door folds it.
 *
 * @throws HttpError word_exists, invalid_word.
 */
export function addWord(
  pool: Pool,
  admin: Admin,
  word: Readonly<{ word: string; match: WordMatch; language: WordLanguage }>,
  requestId: string,
): Promise<void> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ r: string }>(
      "SELECT admin_word_add($1, $2, $3, $4) AS r",
      [word.word, word.match, word.language, requestId],
    );
    if (rows[0]?.r === "exists") {
      throw wordExists();
    }
  });
}

/** One audited change of the lists or the retired names whose only refusal is "nothing there" (404). */
function removal(pool: Pool, admin: Admin, sql: string, values: readonly unknown[]): Promise<void> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ r: string }>(sql, [...values]);
    if (rows[0]?.r === "not_found") {
      throw notFound();
    }
  });
}

/** Removes a word from the lists. @throws HttpError 404 when it is not on them. */
export const removeWord = (pool: Pool, admin: Admin, word: string, requestId: string) =>
  removal(pool, admin, "SELECT admin_word_remove($1, $2) AS r", [word, requestId]);

/** One page of the retired usernames, filtered by a part of the name. */
export function readRetired(
  pool: Pool,
  admin: Admin,
  filter: Readonly<{ q: string | null; after: string | null }>,
): Promise<RetiredName[]> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ r: unknown }>(
      "SELECT console_retired_usernames($1, $2) AS r",
      [filter.q, filter.after],
    );
    return retiredPageSchema.parse(rows[0]?.r);
  });
}

/** Lets a retired name be taken again; the audit holds no name. @throws HttpError 404 when it is not retired. */
export const unretire = (pool: Pool, admin: Admin, name: string, requestId: string) =>
  removal(pool, admin, "SELECT admin_unretire_username($1, $2) AS r", [name, requestId]);
