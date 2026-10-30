/**
 * The finale as Home reports it (T-307b, FR-407): set once the owner revealed the winners. `place` is this player's own
 * place when it is among the frozen ones, else null.
 */
export type Finale = Readonly<{ place: number | null }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The finale, or null: an older API sends none, and an answer this app cannot read is left out. */
export function readFinale(value: unknown): Finale | null {
  if (!isRecord(value)) {
    return null;
  }
  const place = value["place"];
  if (place === null || (typeof place === "number" && Number.isInteger(place) && place >= 1)) {
    return { place };
  }
  return null;
}

/** The phone's key for "this event's finale celebration was seen". */
export const finaleSeenKey = (eventId: string): string => `questify.finaleSeen.${eventId}`;

/** Whether the full-screen celebration plays: the winners are revealed and this phone has not shown it for the event. */
export const celebrates = (finale: Finale | null, seen: boolean): boolean =>
  finale !== null && !seen;
