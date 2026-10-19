/** Largest page any list route returns (docs/API.md, Pagination). */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export type CursorPosition = Readonly<Record<string, unknown>>;

/** Turns a list position into an opaque, URL-safe cursor. */
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

/**
 * Reads a cursor made by {@link encodeCursor}.
 *
 * @throws RangeError when the text is not a cursor.
 */
export function decodeCursor(cursor: string): CursorPosition {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new RangeError("The cursor is not valid. Start again from the first page.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new RangeError("The cursor is not valid. Start again from the first page.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RangeError("The cursor is not valid. Start again from the first page.");
  }
  return parsed as CursorPosition;
}

/**
 * Reads the `limit` query value.
 *
 * @throws RangeError when it is not a whole number from 1 to {@link MAX_PAGE_SIZE}.
 */
export function parseLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new RangeError(`limit must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
  }
  const limit = Number(value);
  if (limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(`limit must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return limit;
}
