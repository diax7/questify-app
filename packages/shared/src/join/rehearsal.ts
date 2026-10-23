/** XXXX-XXXX from capitals and digits without I, O, 0 or 1; the hyphen means no join code can take this shape. */
const REHEARSAL_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

/**
 * A rehearsal code as typed (T-211, ADR-158), in its stored form (trimmed, capitals), or null when the text cannot be
 * one. The app routes such a code to the rehearsal join; the API refuses anything else without a lookup.
 */
export function parseRehearsalCode(text: string): string | null {
  const code = text.trim().toUpperCase();
  return REHEARSAL_CODE.test(code) ? code : null;
}
