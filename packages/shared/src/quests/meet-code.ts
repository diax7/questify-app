/**
 * A meet code (T-303c, ADR-209): what the shown player's app draws as a QR. A 128-bit random token from the API, in
 * base64url, behind a fixed prefix so any scanner of the app can tell it from a quest code. The token is a secret for
 * its minute: it travels only in a request body, and the database keeps only its hash.
 */
export const MEET_CODE_PREFIX = "questify/meet/v1/";

/** 16 bytes in base64url without padding: 22 characters. */
const TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** The text a meet code's QR carries for this token. */
export function meetCodeOf(token: string): string {
  return `${MEET_CODE_PREFIX}${token}`;
}

/** The token a scanned text carries when it is a meet code; undefined for anything else. */
export function meetTokenOf(text: string): string | undefined {
  if (!text.startsWith(MEET_CODE_PREFIX)) {
    return undefined;
  }
  const token = text.slice(MEET_CODE_PREFIX.length);
  return TOKEN.test(token) ? token : undefined;
}
