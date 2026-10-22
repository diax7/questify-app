import { describe, expect, it } from "vitest";
import {
  actionLabel,
  deskInfoOf,
  deskStateKey,
  itemAction,
  lookupOf,
  offerOutcome,
  type DeskInfo,
  type DeskItem,
} from "#src/operator/desk.ts";

const NOW = Date.parse("2030-01-01T12:00:00Z");
const LATER = "2030-01-01T12:01:00Z";
const EARLIER = "2030-01-01T11:59:00Z";

const DESK: DeskInfo = {
  location: null,
  hours: null,
  state: "open",
  confirm: "collect_first",
  timeZone: "Asia/Riyadh",
};
const ITEM: DeskItem = {
  id: "d1",
  kind: "item",
  name: { ar: "هودي", en: "Hoodie" },
  ready: false,
  offered: false,
  offerUntil: null,
};

describe("deskInfoOf", () => {
  it("reads the desk, its windows and how players confirm", () => {
    expect(
      deskInfoOf({
        location: { ar: "القاعة ب", en: null },
        hours: [{ opensAt: EARLIER, closesAt: LATER }, { opensAt: 1 }],
        state: "finished",
        confirm: "desk_offer",
        timeZone: "Asia/Dubai",
      }),
    ).toEqual({
      location: { ar: "القاعة ب", en: null },
      hours: [{ opensAt: EARLIER, closesAt: LATER }],
      state: "finished",
      confirm: "desk_offer",
      timeZone: "Asia/Dubai",
    });
  });

  it("reads an unknown state as closed and an unknown mode as collect first", () => {
    expect(deskInfoOf({ location: null, hours: null, state: "maybe", confirm: "?" })).toEqual({
      location: null,
      hours: null,
      state: "closed",
      confirm: "collect_first",
      timeZone: "Asia/Riyadh",
    });
    expect(deskInfoOf({})).toMatchObject({ state: "closed" });
    expect(deskInfoOf("desk")).toBeUndefined();
    expect(deskInfoOf(null)).toBeUndefined();
  });
});

describe("deskStateKey", () => {
  it("names open with and without hours, closed and finished", () => {
    expect(deskStateKey(DESK)).toBe("operator.desk.alwaysOpen");
    expect(deskStateKey({ ...DESK, hours: [] })).toBe("operator.desk.open");
    expect(deskStateKey({ ...DESK, state: "closed" })).toBe("operator.desk.closed");
    expect(deskStateKey({ ...DESK, state: "finished" })).toBe("operator.desk.finished");
  });
});

const refusedFor = (code: string) => lookupOf({ result: "refused", reason: code });

describe("lookupOf", () => {
  it("reads who was scanned and their waiting items, leaving out broken rows", () => {
    expect(
      lookupOf({
        result: "found",
        player: { username: "sara_88", avatar: "fox" },
        enrollment: "banned",
        items: [
          { id: "d1", kind: "experience", name: { ar: null, en: "Lounge" }, ready: true },
          { kind: "item" },
          { id: "d2", kind: "voucher", name: "x", offered: true, offerUntil: LATER },
        ],
      }),
    ).toEqual({
      kind: "found",
      player: { username: "sara_88", avatar: "fox" },
      enrollment: "banned",
      items: [
        {
          id: "d1",
          kind: "experience",
          name: { ar: null, en: "Lounge" },
          ready: true,
          offered: false,
          offerUntil: null,
        },
        {
          id: "d2",
          kind: "item",
          name: { ar: null, en: null },
          ready: false,
          offered: true,
          offerUntil: LATER,
        },
      ],
    });
  });

  it("names each refusal, and an unknown one as not a player's code", () => {
    expect(refusedFor("invalid_code")).toEqual({
      kind: "refused",
      reason: "operator.red.invalidCode",
    });
    expect(refusedFor("old_code")).toEqual({ kind: "refused", reason: "operator.red.oldCode" });
    expect(refusedFor("not_in_event")).toEqual({
      kind: "refused",
      reason: "operator.red.notInEvent",
    });
    expect(refusedFor("self_scan")).toEqual({ kind: "refused", reason: "operator.red.selfScan" });
    expect(refusedFor("ability_off")).toEqual({
      kind: "refused",
      reason: "operator.desk.abilityOff",
    });
    expect(refusedFor("new_reason")).toEqual({
      kind: "refused",
      reason: "operator.red.invalidCode",
    });
  });

  it("refuses what is not an answer, and reads a missing enrollment as active", () => {
    expect(lookupOf("found")).toBeUndefined();
    expect(lookupOf({ result: "found", items: [] })).toBeUndefined();
    expect(lookupOf({ result: "found", player: { username: "a" } })).toBeUndefined();
    expect(lookupOf({ result: "maybe", player: {}, items: [] })).toBeUndefined();
    expect(
      lookupOf({ result: "found", player: { username: "a", avatar: "b" }, items: [] }),
    ).toEqual({
      kind: "found",
      player: { username: "a", avatar: "b" },
      enrollment: "active",
      items: [],
    });
  });
});

describe("itemAction", () => {
  it("blocks a banned player and holds everything while the desk is closed", () => {
    expect(itemAction({ ...ITEM, ready: true }, DESK, "banned", NOW)).toBe("blocked");
    expect(itemAction({ ...ITEM, ready: true }, { ...DESK, state: "closed" }, "active", NOW)).toBe(
      "closed",
    );
    expect(itemAction(ITEM, { ...DESK, state: "finished" }, "active", NOW)).toBe("closed");
  });

  it("hands over after the player's Collect (collect first)", () => {
    expect(itemAction(ITEM, DESK, "active", NOW)).toBe("not_ready");
    expect(itemAction({ ...ITEM, ready: true }, DESK, "active", NOW)).toBe("hand_over");
  });

  it("offers, and waits while this desk's own offer is live (desk offer)", () => {
    const offerDesk: DeskInfo = { ...DESK, confirm: "desk_offer" };
    expect(itemAction(ITEM, offerDesk, "active", NOW)).toBe("offer");
    expect(
      itemAction({ ...ITEM, offered: true, offerUntil: LATER }, offerDesk, "active", NOW),
    ).toBe("waiting");
    expect(
      itemAction({ ...ITEM, offered: true, offerUntil: EARLIER }, offerDesk, "active", NOW),
    ).toBe("offer");
    expect(itemAction({ ...ITEM, offered: true, offerUntil: null }, offerDesk, "active", NOW)).toBe(
      "offer",
    );
    expect(
      itemAction({ ...ITEM, offered: false, offerUntil: LATER }, offerDesk, "active", NOW),
    ).toBe("offer");
  });
});

describe("actionLabel", () => {
  it("confirms an experience and hands over an item", () => {
    expect(actionLabel({ ...ITEM, kind: "experience" }, "hand_over")).toBe("operator.confirm");
    expect(actionLabel({ ...ITEM, kind: "experience" }, "offer")).toBe("operator.confirm");
    expect(actionLabel(ITEM, "hand_over")).toBe("operator.desk.handedOver");
    expect(actionLabel(ITEM, "offer")).toBe("operator.desk.handOver");
  });
});

describe("offerOutcome", () => {
  it("knows accepted, waiting, lapsed and ended", () => {
    expect(offerOutcome({ status: "handed_over", offered: false, offerUntil: null }, NOW)).toBe(
      "accepted",
    );
    expect(offerOutcome({ status: "reserved", offered: true, offerUntil: LATER }, NOW)).toBe(
      "waiting",
    );
    expect(offerOutcome({ status: "reserved", offered: true, offerUntil: EARLIER }, NOW)).toBe(
      "lapsed",
    );
    expect(offerOutcome({ status: "reserved", offered: false, offerUntil: LATER }, NOW)).toBe(
      "lapsed",
    );
    expect(offerOutcome({ status: "reserved", offered: true, offerUntil: null }, NOW)).toBe(
      "lapsed",
    );
    expect(offerOutcome({ status: "cancelled", offered: false, offerUntil: null }, NOW)).toBe(
      "ended",
    );
  });
});
