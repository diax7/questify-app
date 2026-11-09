import type { SavedFirstBonus } from "#src/lib/quests.ts";

/** The smallest value a first-bonus number field accepts: the limit, and for the slots never below the number already given. */
export function firstBonusMin(
  key: "firstBonusPoints" | "firstBonusSlots",
  limitMin: number,
  saved: SavedFirstBonus | null,
): number {
  return key === "firstBonusSlots" ? Math.max(limitMin, saved?.given ?? 0) : limitMin;
}

/** Which lines and buttons a saved first-N bonus adds to its form. */
export function firstBonusNotes(saved: SavedFirstBonus | null): Readonly<{
  locked: boolean;
  belowGiven: boolean;
  canStop: boolean;
}> {
  return {
    locked: saved?.locked === true,
    belowGiven: saved !== null && saved.given > 0,
    canStop: saved !== null && saved.left > 0,
  };
}
