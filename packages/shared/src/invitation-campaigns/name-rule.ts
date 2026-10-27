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

const CONTROL = /[\p{Cc}\p{Cf}]/u;
/** A dot-like character with a letter or a digit of any script on both sides (no domain list). */
const DOTTED = /[\p{L}\p{N}][.。．｡․۔][\p{L}\p{N}]/u;
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
  if (CONTROL.test(text) || CONTROL.test(folded)) return "control_characters";
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
