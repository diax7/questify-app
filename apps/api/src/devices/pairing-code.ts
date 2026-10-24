import { randomInt } from "node:crypto";

/** 31 letters and digits, without 0, O, 1, I and L, which are easy to misread on a screen across a room. */
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** 8 characters: about 40 bits, alive 10 minutes (ADR-239). */
export const PAIRING_CODE_LENGTH = 8;

/** A fresh pairing code, uniformly random over the alphabet: `ABCDEFGH`. */
export function generatePairingCode(): string {
  let code = "";
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_ALPHABET[randomInt(0, PAIRING_ALPHABET.length)];
  }
  return code;
}

/** The code as a screen shows it: `ABCD-EFGH`. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * A typed or scanned code in its stored form: case, dashes and spaces ignored. Undefined when it is not 8 characters of
 * the alphabet (an excluded letter such as O or I is refused, never guessed).
 */
export function normalizePairingCode(typed: string): string | undefined {
  const code = typed.replaceAll(/[\s-]/g, "").toUpperCase();
  if (code.length !== PAIRING_CODE_LENGTH) {
    return undefined;
  }
  return [...code].every((character) => PAIRING_ALPHABET.includes(character)) ? code : undefined;
}
