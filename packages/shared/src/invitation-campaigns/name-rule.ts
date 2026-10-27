/**
 * The name rule for Questify invitations (T-409, ADR-331 (5)): an event name goes into a promotional SMS sent under
 * Questify's sender, so a name that hides an address, a phone number or invisible characters is refused before an admin
 * sees it. It is a filter, not the gate: the admin approving the exact rendered text is the gate, and spelled-out forms
 * ("example dot com") are the admin's to catch. JavaScript's `\p{...}` classes do not depend on a database locale, so
 * the rule lives here and the SQL holds no copy of it.
 */

/** At most this many UTF-16 units of the event's name go into a message, then `...` (ADR-331 (3)). */
export const INVITATION_NAME_UNITS = 40;

/** Why a name cannot go into an invitation. */
export type InvitationNameIssue = "control_characters" | "looks_like_address" | "looks_like_phone";

/**
 * Control and format characters, and every default-ignorable one (variation selectors, the combining grapheme joiner,
 * fillers): a browser draws none of them, so `example.\uFE0Fcom` reads as `example.com` (T-409 code review). Built on
 * first use, not at load: the app imports this package, and the release Hermes need never compile a binary property.
 */
let control: RegExp | undefined;
const controlPattern = (): RegExp =>
  (control ??= new RegExp(String.raw`[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]`, "u"));
/**
 * A dot-like character with a letter or a digit of any script on both sides (no domain list), combining marks allowed
 * around the dot (`example.\u0301com` still reads as an address).
 */
const DOTTED = /[\p{L}\p{N}]\p{M}*[.。．｡․۔]\p{M}*[\p{L}\p{N}]/u;
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]/gu;
/** Nine or more decimal digits of any script in a row, once everything but letters and digits is gone. */
const PHONE_RUN = /\p{Nd}{9,}/u;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * The name as a message carries it: trimmed, then cut to at most 40 UTF-16 units without splitting a surrogate pair,
 * with `...` when it was cut.
 */
export function trimName(name: string): string {
  const text = name.trim();
  if (text.length <= INVITATION_NAME_UNITS) return text;
  const cut = isHighSurrogate(text.charCodeAt(INVITATION_NAME_UNITS - 1))
    ? INVITATION_NAME_UNITS - 1
    : INVITATION_NAME_UNITS;
  return `${text.slice(0, cut)}...`;
}

function issueOf(text: string): InvitationNameIssue | null {
  const folded = text.normalize("NFKC");
  if (controlPattern().test(text) || controlPattern().test(folded)) return "control_characters";
  if (folded.includes("://") || folded.includes("@") || DOTTED.test(folded)) {
    return "looks_like_address";
  }
  if (PHONE_RUN.test(folded.replace(NOT_LETTER_OR_DIGIT, ""))) return "looks_like_phone";
  return null;
}

/**
 * Why an event name cannot go into an invitation, or null when it can. Checked on the whole name and on the cut text
 * exactly as sent, each in its NFKC form.
 */
export function invitationNameIssue(name: string): InvitationNameIssue | null {
  return issueOf(name) ?? issueOf(trimName(name));
}
