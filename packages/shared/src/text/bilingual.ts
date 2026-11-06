import { z } from "zod";
import { hasUnsafeCharacter } from "#src/i18n/translate";

/** Digits of any other script clash with the Western digits every screen uses (ADR-018). */
const OTHER_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/;
const ARABIC_LETTER = /\p{Script=Arabic}/u;

/** A name or a line an admin types: trimmed, 1 to `max` characters, Western digits, no control or direction character. */
export const cleanText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !OTHER_DIGITS.test(value), "Western digits only")
    .refine((value) => !hasUnsafeCharacter(value), "no control or direction characters");

/** Arabic text holds an Arabic letter; a swapped language is caught here. */
export const arabicText = (max: number) =>
  cleanText(max).refine((value) => ARABIC_LETTER.test(value), "must be written in Arabic");

/** English text holds no Arabic letter. */
export const englishText = (max: number) =>
  cleanText(max).refine((value) => !ARABIC_LETTER.test(value), "must be written in English");
