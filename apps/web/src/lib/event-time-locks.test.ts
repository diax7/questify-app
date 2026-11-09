import { describe, expect, it } from "vitest";
import { eventTimeLocks } from "#src/lib/event-time-locks.ts";
import type { EventStatus } from "#src/lib/events.ts";

describe("eventTimeLocks", () => {
  it("locks nothing before the event is live", () => {
    for (const status of ["draft", "scheduled"] as EventStatus[]) {
      expect(eventTimeLocks(status)).toEqual({
        zoneLocked: false,
        startsAtLocked: false,
        endsAtLocked: false,
        hintKey: null,
      });
    }
  });

  it("leaves only the end open while live", () => {
    expect(eventTimeLocks("live")).toEqual({
      zoneLocked: true,
      startsAtLocked: true,
      endsAtLocked: false,
      hintKey: "events.liveHint",
    });
  });

  it("locks everything once ended or archived", () => {
    for (const status of ["ended", "archived"] as EventStatus[]) {
      expect(eventTimeLocks(status)).toEqual({
        zoneLocked: true,
        startsAtLocked: true,
        endsAtLocked: true,
        hintKey: "events.endedHint",
      });
    }
  });
});
