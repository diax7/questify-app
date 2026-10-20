/** A username's length in characters (0001's CHECK holds the same bounds). */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

/** Arabic letters U+0621–U+064A without the tatweel U+0640: no tashkeel, no stretching, no marks. */
const ARABIC_LETTERS = "\u0621-\u063A\u0641-\u064A";
const ARABIC = new RegExp(`^[${ARABIC_LETTERS}0-9_]+$`);
const LATIN = /^[A-Za-z0-9_]+$/;
const EITHER = new RegExp(`^[${ARABIC_LETTERS}A-Za-z0-9_]+$`);
const HAS_ARABIC_LETTER = new RegExp(`[${ARABIC_LETTERS}]`);
const HAS_LATIN_LETTER = /[A-Za-z]/;

export type UsernameCheck =
  | Readonly<{ ok: true; username: string }>
  | Readonly<{ ok: false; reason: "length" | "characters" | "mixed_scripts" }>;

/**
 * A player's username (T-107; T-109 adds the word filter and changes): NFKC first, then 3–30 characters of Arabic
 * letters or Latin letters (not both in one name: mixed scripts read badly right to left), Western digits (ADR-018) and
 * `_`, with at least one letter. Unique ignoring case, which the database enforces.
 */
export function checkUsername(raw: string): UsernameCheck {
  const username = raw.normalize("NFKC").trim();
  const length = [...username].length;
  if (length < USERNAME_MIN || length > USERNAME_MAX) {
    return { ok: false, reason: "length" };
  }
  if (!HAS_ARABIC_LETTER.test(username) && !HAS_LATIN_LETTER.test(username)) {
    // Digits and _ alone are not a name a person can be told apart by.
    return { ok: false, reason: "characters" };
  }
  if (!ARABIC.test(username) && !LATIN.test(username)) {
    return EITHER.test(username) &&
      HAS_ARABIC_LETTER.test(username) &&
      HAS_LATIN_LETTER.test(username)
      ? { ok: false, reason: "mixed_scripts" }
      : { ok: false, reason: "characters" };
  }
  return { ok: true, username };
}
