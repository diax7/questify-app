import { useEffect, useSyncExternalStore } from "react";

/**
 * The event in which Home last said the player is the App Review reviewer while the window is open (T-710b, ADR-565),
 * or null. Kept in memory only: a restart forgets it until Home is read again, and any other answer clears it.
 */
let flagged: string | null = null;
const listeners = new Set<() => void>();

export function noteReviewDemo(eventId: string, reviewDemo: boolean): void {
  if (reviewDemo === (flagged === eventId)) {
    return;
  }
  flagged = reviewDemo ? eventId : null;
  for (const listener of listeners) {
    listener();
  }
}

export function isReviewDemoEvent(eventId: string): boolean {
  return flagged === eventId;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Whether the scanner of this event offers the review picker. */
export function useReviewDemo(eventId: string): boolean {
  return useSyncExternalStore(subscribe, () => isReviewDemoEvent(eventId));
}

/** Home's side: notes the flag of each Home it reads. */
export function useNoteReviewDemo(
  eventId: string,
  home: Readonly<{ reviewDemo: boolean }> | undefined,
): void {
  const reviewDemo = home?.reviewDemo;
  useEffect(() => {
    if (reviewDemo !== undefined) {
      noteReviewDemo(eventId, reviewDemo);
    }
  }, [eventId, reviewDemo]);
}
