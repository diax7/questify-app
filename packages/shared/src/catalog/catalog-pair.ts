import { z } from "zod";
import { arabicText, englishText } from "#src/text/bilingual";

/** Zero-width and mark characters (U+200B to U+200F, U+061C, U+FEFF) that `catalog_text` refuses (ADR-746). */
const INVISIBLE_CHARACTER = /[\u061C\u200B-\u200F\uFEFF]/;
const refuseInvisible = (value: string) => !INVISIBLE_CHARACTER.test(value);
const INVISIBLE_MESSAGE = "no zero-width or mark characters";

/**
 * An Arabic and an English name or line the console saves through `catalog_text`: the language checks of `arabicText` and
 * `englishText` plus the zero-width and mark refusal, so the console names the field instead of the database refusing with
 * CA400 (ADR-780). Only a catalog doc uses it: a template body is text `catalog_text` never reads, so its titles keep
 * `arabicText` and `englishText` alone.
 */
export const catalogPair = (max: number) =>
  z.strictObject({
    ar: arabicText(max).refine(refuseInvisible, INVISIBLE_MESSAGE),
    en: englishText(max).refine(refuseInvisible, INVISIBLE_MESSAGE),
  });
