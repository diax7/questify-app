import { describe, expect, it } from "vitest";
import { historyKeyOf } from "#src/lib/console-organizers.ts";

describe("the words for an audit action in the console's history", () => {
  it.each([
    ["event.suspend", "console.history.eventSuspend"],
    ["event.reactivate", "console.history.eventReactivate"],
    ["organizer.suspend", "console.history.organizerSuspend"],
    ["organizer.reactivate", "console.history.organizerReactivate"],
    ["support.opened", "console.history.supportOpened"],
    ["support.closed", "console.history.supportClosed"],
    ["console.organizer_read", "console.history.read"],
    ["console.player_ledger_read", "console.history.read"],
  ])("says %s with %s", (action, key) => {
    expect(historyKeyOf(action)).toBe(key);
  });

  it.each(["event.update", "console.read", "constructor", "__proto__", ""])(
    "has none for %j, so the stored name is shown",
    (action) => {
      expect(historyKeyOf(action)).toBeUndefined();
    },
  );
});
