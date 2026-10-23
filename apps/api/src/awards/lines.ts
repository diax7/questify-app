import { normalizeSaudiMobile } from "#src/players/phone";

/** Most lines a bulk-award list may hold (migration 0030 enforces it too). */
export const MAX_LINES = 2000;

export type BulkLines = Readonly<{ usernames: string[]; phones: string[] }>;

/**
 * A pasted or uploaded list (FR-1712): one entry per line, or separated by commas, semicolons or tabs. A Saudi mobile
 * in any common form becomes E.164; anything else is a username (a leading `@` dropped). Blanks and repeats go.
 *
 * @returns the lines split by kind, or `too_many` past {@link MAX_LINES} distinct entries.
 */
export function parseBulkLines(text: string): BulkLines | "too_many" {
  const usernames = new Set<string>();
  const phones = new Set<string>();
  for (const raw of text.split(/[\n\r,;\t]+/)) {
    const entry = raw.trim();
    if (entry.replace(/^@/, "") === "") {
      continue;
    }
    const phone = normalizeSaudiMobile(entry);
    if (phone === undefined) {
      usernames.add(entry.replace(/^@/, ""));
    } else {
      phones.add(phone);
    }
    if (usernames.size + phones.size > MAX_LINES) {
      return "too_many";
    }
  }
  return { usernames: [...usernames], phones: [...phones] };
}
