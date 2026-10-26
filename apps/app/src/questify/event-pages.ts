import type { OwnEvent } from "@questify/shared";

/** Appends a page to the rows already shown, dropping any event that is already in the list. */
export function appendPage(
  current: readonly OwnEvent[],
  page: readonly OwnEvent[],
): readonly OwnEvent[] {
  const seen = new Set(current.map((event) => event.eventId));
  return [...current, ...page.filter((event) => !seen.has(event.eventId))];
}

/** Runs one piece of work at a time: a call made while another is running is ignored. */
export function createSingleFlight(): (work: () => Promise<void>) => Promise<void> {
  let busy = false;
  return async (work) => {
    if (busy) return;
    busy = true;
    try {
      await work();
    } finally {
      busy = false;
    }
  };
}
