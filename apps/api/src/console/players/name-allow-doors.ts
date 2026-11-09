import { allowPageSchema, type AllowPage, type WordLanguage } from "@questify/shared";
import type { Pool } from "pg";
import { notFound, wordExists } from "#src/auth/http-errors";
import { door, type Admin } from "#src/console/doors";

export type AllowFilter = Readonly<{
  q: string | null;
  language: WordLanguage | null;
  after: string | null;
}>;

/** One page of the full-name allow-list, filtered (`console_name_allow`, migration 0185). */
export function readAllowWords(pool: Pool, admin: Admin, filter: AllowFilter): Promise<AllowPage> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ r: unknown }>(
      "SELECT console_name_allow($1, $2, $3) AS r",
      [filter.q, filter.language, filter.after],
    );
    return allowPageSchema.parse(rows[0]?.r);
  });
}

/**
 * Allows a word of a real name in a full name (ADR-817). The door folds it as the check reads a name, takes its language
 * from its letters, and the list trigger marks the stored names for the sweep.
 *
 * @throws HttpError word_exists, invalid_allow_word, allow_word_listed, allow_word_unsafe.
 */
export function addAllowWord(
  pool: Pool,
  admin: Admin,
  word: string,
  requestId: string,
): Promise<void> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ r: string }>("SELECT admin_name_allow_add($1, $2) AS r", [
      word,
      requestId,
    ]);
    if (rows[0]?.r === "exists") {
      throw wordExists();
    }
  });
}

/** Stops allowing a word; the names that hold it are refused and hidden again. @throws HttpError 404 when not listed. */
export function removeAllowWord(
  pool: Pool,
  admin: Admin,
  word: string,
  requestId: string,
): Promise<void> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ r: string }>(
      "SELECT admin_name_allow_remove($1, $2) AS r",
      [word, requestId],
    );
    if (rows[0]?.r === "not_found") {
      throw notFound();
    }
  });
}
