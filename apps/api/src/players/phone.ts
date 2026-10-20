import { toWesternDigits } from "@questify/shared";

/** What people paste around a number: spaces (NBSP too), dashes, dots, parentheses, direction marks. */
const DECORATION = /[\s \-.()‎‏‪-‮]/g;
/** A Saudi mobile: 5, then 8 digits (no operator table: carriers' prefixes change). */
const NATIONAL = /^5[0-9]{8}$/;

/**
 * A Saudi mobile number as the database stores it (`+9665XXXXXXXX`, 0005's CHECK), from what a person types:
 * `05XXXXXXXX`, `5XXXXXXXX`, `+9665…`, `9665…`, `009665…`, `+966 05…`, with Arabic-Indic digits and the usual
 * decoration. Anything else is not one (FR-106, FR-108: no code goes to it).
 */
export function normalizeSaudiMobile(typed: string): string | undefined {
  const digits = toWesternDigits(typed).replace(DECORATION, "");
  const national = digits
    .replace(/^\+966/, "")
    .replace(/^00966/, "")
    .replace(/^966(?=0?5[0-9]{8}$)/, "")
    .replace(/^0(?=5)/, "");
  return NATIONAL.test(national) ? `+966${national}` : undefined;
}
