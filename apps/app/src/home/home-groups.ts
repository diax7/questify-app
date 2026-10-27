import type { MyEvent } from "#src/event/launch.ts";

export type HomeGroups = Readonly<{
  live: readonly MyEvent[];
  upcoming: readonly MyEvent[];
  past: readonly MyEvent[];
}>;

const instant = (value: string | null | undefined): number | null => {
  const time = value === null || value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(time) ? null : time;
};

/** Ascending; an event without a date comes last. */
const bySoonest = (a: MyEvent, b: MyEvent): number => {
  const first = instant(a.startsAt);
  const second = instant(b.startsAt);
  if (first === second) return 0;
  if (first === null) return 1;
  if (second === null) return -1;
  return first - second;
};

const endedAt = (event: MyEvent): number | null => instant(event.endsAt) ?? instant(event.startsAt);

/** Descending; an event without a date comes last. */
const byNewest = (a: MyEvent, b: MyEvent): number => {
  const first = endedAt(a);
  const second = endedAt(b);
  if (first === second) return 0;
  if (first === null) return 1;
  if (second === null) return -1;
  return second - first;
};

/**
 * The player's events as Questify Home groups them (FR-832): live now; upcoming (scheduled, or a rehearsal's draft),
 * soonest first; past (ended or archived), newest first. Pending and declined requests sit in the group of their
 * event, so their note shows where the event is. The sort is stable, so equal dates keep the server's order.
 */
export function groupEvents(events: readonly MyEvent[]): HomeGroups {
  const live: MyEvent[] = [];
  const upcoming: MyEvent[] = [];
  const past: MyEvent[] = [];
  for (const event of events) {
    if (event.statusNow === "live") live.push(event);
    else if (event.statusNow === "scheduled" || event.statusNow === "draft") upcoming.push(event);
    else past.push(event);
  }
  return { live, upcoming: upcoming.sort(bySoonest), past: past.sort(byNewest) };
}

/** How many past events Home lists before sending the player to the event history. */
export const PAST_SHOWN = 5;
