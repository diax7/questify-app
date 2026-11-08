import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { historyKeyOf } from "#src/lib/console-history.ts";
import { readOrganizerDetail } from "#src/lib/console-organizers.ts";

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
    ["event.update", "console.history.eventEdit"],
    ["event.names.update", "console.history.eventEdit"],
    ["event.texts.update", "console.history.eventEdit"],
    ["event.branding.update", "console.history.eventEdit"],
    ["event.layout.update", "console.history.eventEdit"],
    ["event.terms.update", "console.history.eventEdit"],
    ["event.focus_set", "console.history.eventEdit"],
    ["event.join_fields.update", "console.history.eventJoin"],
    ["event.join_rules.update", "console.history.eventJoin"],
    ["event.features.update", "console.history.eventFeatures"],
    ["event.shop.update", "console.history.eventShop"],
    ["event.guests.add", "console.history.guestsChange"],
    ["event.guests.remove", "console.history.guestsChange"],
    ["category.create", "console.history.categoryChange"],
    ["category.update", "console.history.categoryChange"],
    ["category.delete", "console.history.categoryChange"],
    ["category.reorder", "console.history.categoryChange"],
    ["quest.create", "console.history.questCreate"],
    ["quest.update", "console.history.questEdit"],
    ["quest.reorder", "console.history.questEdit"],
    ["quest_item.create", "console.history.questEdit"],
    ["quest_item.update", "console.history.questEdit"],
    ["quest_item.remove", "console.history.questEdit"],
    ["quest.delete", "console.history.questDelete"],
    ["quest.qr_regenerate", "console.history.questQr"],
    ["quest.step_qr_regenerate", "console.history.questQr"],
    ["reward.create", "console.history.rewardChange"],
    ["reward.update", "console.history.rewardChange"],
    ["reward.remove", "console.history.rewardChange"],
    ["reward.codes.add", "console.history.rewardChange"],
    ["rank_prize.create", "console.history.rewardChange"],
    ["rank_prize.update", "console.history.rewardChange"],
    ["rank_prize.remove", "console.history.rewardChange"],
    ["feature_request.allow", "console.history.featureRequestAllow"],
    ["feature_request.decline", "console.history.featureRequestDecline"],
    ["organizer.member.invite_cancel", "console.history.inviteCancel"],
  ])("says %s with %s", (action, key) => {
    expect(historyKeyOf(action)).toBe(key);
    expect(MESSAGES[key as keyof typeof MESSAGES]).toBeDefined();
  });

  it.each(["event.unknown_edit", "console.read", "constructor", "__proto__", ""])(
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
