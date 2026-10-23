import type { Language } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";

/** A player's name for a sentence that places it itself (`{name}`): the username, or "Deleted player" (T-217). */
export function nameOf(username: string | null, language: Language): string {
  return username ?? translatorFor(language)("player.deleted");
}

/** A player's name as a list shows it: `@username`, or "Deleted player" for a deleted account (T-217, FR-1739). */
export function handleOf(username: string | null, language: Language): string {
  return username === null ? nameOf(null, language) : `@${username}`;
}
