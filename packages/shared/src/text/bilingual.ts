import { z } from "zod";
import { hasUnsafeCharacter } from "#src/i18n/translate";

/** Digits of any other script clash with the Western digits every screen uses (ADR-018). */
const OTHER_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/;
const ARABIC_LETTER = /\p{Script=Arabic}/u;
/** Zero-width and mark characters (U+200B to U+200F, U+061C, U+FEFF) that `catalog_text` refuses too (ADR-746). */
const INVISIBLE_CHARACTER = /[\u061C\u200B-\u200F\uFEFF]/;

/**
 * A name or a line an admin types: trimmed, 1 to `max` characters, Western digits, no control, direction or
 * zero-width character (the same set `catalog_text` refuses, so the console names the field).
 */
export const cleanText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !OTHER_DIGITS.test(value), "Western digits only")
    .refine((value) => !hasUnsafeCharacter(value), "no control or direction characters")
    .refine((value) => !INVISIBLE_CHARACTER.test(value), "no zero-width or mark characters");

/** Arabic text holds an Arabic letter; a swapped language is caught here. */
export const arabicText = (max: number) =>
  cleanText(max).refine((value) => ARABIC_LETTER.test(value), "must be written in Arabic");

/** English text holds no Arabic letter. */
export const englishText = (max: number) =>
  cleanText(max).refine((value) => !ARABIC_LETTER.test(value), "must be written in English");
