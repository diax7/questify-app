import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { historyKeyOf, readOrganizerDetail } from "#src/lib/console-organizers.ts";

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
    ["event.create", "console.history.eventCreate"],
    ["event.duplicate", "console.history.eventDuplicate"],
    ["event.delete", "console.history.eventDelete"],
    ["event.template", "console.history.eventTemplate"],
    ["event.activation.request", "console.history.activationRequest"],
    ["event.activation.withdraw", "console.history.activationWithdraw"],
    ["event.activation.reject", "console.history.activationReject"],
    ["event.activate", "console.history.eventActivate"],
    ["event.limit", "console.history.eventLimit"],
    ["event.end", "console.history.eventEnd"],
    ["event.lifecycle", "console.history.eventLifecycle"],
    ["event.results_confirmed", "console.history.resultsConfirmed"],
    ["event.results_revealed", "console.history.resultsRevealed"],
    ["event.export", "console.history.eventExport"],
    ["event.player_ban", "console.history.playerBan"],
    ["event.player_unban", "console.history.playerUnban"],
    ["content.unpublish", "console.history.contentUnpublish"],
    ["content.republish", "console.history.contentRepublish"],
    ["organizer.create", "console.history.organizerCreate"],
    ["organizer.owner.transfer", "console.history.ownerTransfer"],
    ["organizer.member.join", "console.history.memberJoin"],
    ["organizer.member.remove", "console.history.memberRemove"],
    ["organizer.member.scope", "console.history.memberScope"],
  ])("says %s with %s", (action, key) => {
    expect(historyKeyOf(action)).toBe(key);
    expect(MESSAGES[key as keyof typeof MESSAGES]).toBeDefined();
  });

  it.each(["event.update", "console.read", "constructor", "__proto__", ""])(
    "has none for %j, so the stored name is shown",
    (action) => {
      expect(historyKeyOf(action)).toBeUndefined();
    },
  );
});

const detail = (history: unknown) => ({ organizer: { id: "o1", name: "Najd" }, history });

describe("the reason beside a history entry", () => {
  it("is read for an entry that carries one, and null for the rest", () => {
    const read = readOrganizerDetail(
      detail([
        { id: "2", at: "2030-01-02T00:00:00Z", action: "organizer.suspend", reason: "Unpaid" },
        { id: "1", at: "2030-01-01T00:00:00Z", action: "event.create" },
      ]),
    );
    expect(read?.history.map((entry) => entry.reason)).toEqual(["Unpaid", null]);
  });

  it("is null when the API sends something that is not text", () => {
    const read = readOrganizerDetail(
      detail([{ id: "1", at: "2030-01-01T00:00:00Z", action: "organizer.suspend", reason: 7 }]),
    );
    expect(read?.history[0]?.reason).toBeNull();
  });
});
