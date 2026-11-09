import type { EventStatus } from "#src/lib/events.ts";

/** What the event form may still change by status: once live only the end moves later, once ended nothing (the API enforces both). */
export type EventTimeLocks = Readonly<{
  /** The zone and the day-start hour. */
  zoneLocked: boolean;
  startsAtLocked: boolean;
  endsAtLocked: boolean;
  /** The message key above the times, if any. */
  hintKey: "events.endedHint" | "events.liveHint" | null;
}>;

export function eventTimeLocks(status: EventStatus): EventTimeLocks {
  const started = status === "live";
  const finished = status === "ended" || status === "archived";
  return {
    zoneLocked: started || finished,
    startsAtLocked: started || finished,
    endsAtLocked: finished,
    hintKey: finished ? "events.endedHint" : started ? "events.liveHint" : null,
  };
}

/** A number input's change: the new number, or null for an emptied field (it keeps its last value). */
export function numberFieldPatch<Key extends string>(
  key: Key,
  raw: string,
): Record<Key, number> | null {
  return raw === "" ? null : ({ [key]: Number(raw) } as Record<Key, number>);
}
