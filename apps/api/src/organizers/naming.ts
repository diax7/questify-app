import { randomInt } from "node:crypto";

export const MIN_NAME_LENGTH = 2;
export const MAX_NAME_LENGTH = 80;

/**
 * Text that reads as a web address or an email. Organizer names reach other people's inboxes in invites, so a name
 * like "Account suspended, visit pay-now.co" must not become a phishing line sent from Questify's domain.
 */
const LOOKS_LIKE_ADDRESS = /:\/\/|www\.|@|[\p{L}\p{N}-]\.[a-z]{2,}(?![\p{L}\p{N}])/iu;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export type NameCheck =
  | Readonly<{ ok: true; name: string }>
  | Readonly<{
      ok: false;
      reason: "too_short" | "too_long" | "control_characters" | "looks_like_address";
    }>;

/** Trims and checks an organizer name: 2 to 80 characters, no control characters, nothing that reads as an address. */
export function checkOrganizerName(raw: string): NameCheck {
  const name = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  const length = [...name].length;
  if (length < MIN_NAME_LENGTH) {
    return { ok: false, reason: "too_short" };
  }
  if (length > MAX_NAME_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  if (CONTROL.test(name)) {
    return { ok: false, reason: "control_characters" };
  }
  if (LOOKS_LIKE_ADDRESS.test(name)) {
    return { ok: false, reason: "looks_like_address" };
  }
  return { ok: true, name };
}

const randomPart = (length: number): string =>
  Array.from({ length }, () => SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)]).join("");

/**
 * A URL slug for a new organizer: the name's Latin letters and digits, then six random characters so two "Najd
 * Events" never collide. A name with no Latin letters (an Arabic name) gets a random slug.
 */
export function slugFor(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return base === "" ? `org-${randomPart(10)}` : `${base}-${randomPart(6)}`;
}
