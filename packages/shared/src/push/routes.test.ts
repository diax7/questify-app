import { describe, expect, it } from "vitest";
import { NOTIFICATION_TARGETS, isEventId, notificationRoute } from "#src/push/routes";
import { FREE_TEXT_KINDS, PUSH_TEMPLATES } from "#src/push/templates";

const EVENT = "5f0f2b0e-8c3e-4d7c-9a51-2a2f0b1c3d4e";
const QUEST = "0b9a7d3c-1f2e-4a5b-8c6d-7e8f9a0b1c2d";

const hrefOf = (kind: string, eventId: string | null, refs: Record<string, string> = {}) => {
  const route = notificationRoute(kind, eventId, refs);
  return route.kind === "route" ? route.href : "center";
};

describe("notificationRoute", () => {
  it("opens the event's screens from the kind and the event id", () => {
    const screens: Record<string, string> = {
      join_accepted: "",
      event_soon: "",
      poll_sent: "",
      community_step: "",
      announcement: "",
      flash_quest: "/quests",
      boost_start: "/quests",
      category_open: "/quests",
      category_hint: "/quests",
      submission_approved: "/quests",
      submission_rejected: "/quests",
      rank_prize: "/rewards",
      reward_ready: "/rewards",
      reward_ending: "/rewards",
      shop_closing: "/rewards",
      rank_top_ten: "/ranking",
      session_reminder: "/info",
    };
    for (const [kind, screen] of Object.entries(screens)) {
      expect(hrefOf(kind, EVENT), kind).toBe(`/event/${EVENT}${screen}`);
    }
    expect(hrefOf("submission_rejected", EVENT, { quest: QUEST })).toBe(
      `/event/${EVENT}/quests?quest=${QUEST}`,
    );
  });

  it("opens the quests tab, on the quest's sheet when the notice names one", () => {
    expect(hrefOf("flash_quest", EVENT)).toBe(`/event/${EVENT}/quests`);
    expect(hrefOf("flash_quest", EVENT, { quest: QUEST })).toBe(
      `/event/${EVENT}/quests?quest=${QUEST}`,
    );
    expect(hrefOf("submission_approved", EVENT, { quest: "42" })).toBe(
      `/event/${EVENT}/quests?quest=42`,
    );
  });

  it("puts only a checked id in a route", () => {
    for (const quest of [
      "x&y=1",
      "../..",
      "42/",
      "https://example.com",
      "",
      " 5",
      "1".repeat(19),
    ]) {
      expect(hrefOf("flash_quest", EVENT, { quest }), quest).toBe(`/event/${EVENT}/quests`);
    }
    for (const event of [
      "../admin",
      `${EVENT}/x`,
      `${EVENT}?a=b`,
      `x${EVENT}`,
      "",
      "5",
      EVENT.toUpperCase(),
    ]) {
      expect(hrefOf("join_accepted", event), event).toBe("center");
    }
    expect(hrefOf("join_accepted", null)).toBe("center");
  });

  it("opens screens that need no event without one", () => {
    expect(hrefOf("streak_reminder", null)).toBe("/home");
    expect(hrefOf("help_answered", null)).toBe("/requests");
    expect(hrefOf("help_answered", EVENT)).toBe("/requests");
    for (const kind of ["help_answered_questify", "help_solved"]) {
      expect(hrefOf(kind, null), kind).toBe("/requests");
      expect(hrefOf(kind, EVENT), kind).toBe("/requests");
    }
  });

  it("opens the center row for a promotion, a decision with nothing to open and a kind it does not know", () => {
    for (const kind of ["invitation", "join_declined", "operator_invite"]) {
      expect(notificationRoute(kind, EVENT, {}), kind).toEqual({ kind: "center" });
    }
    for (const kind of ["from_a_newer_app", "", "constructor", "__proto__", "toString"]) {
      expect(hrefOf(kind, EVENT), kind).toBe("center");
    }
  });
});

describe("the route table", () => {
  it("has a route (or the center) for every kind that has a template", () => {
    for (const kind of [...Object.keys(PUSH_TEMPLATES), ...FREE_TEXT_KINDS]) {
      expect(NOTIFICATION_TARGETS.has(kind), kind).toBe(true);
    }
  });

  it("names kinds the way notice_kind does", () => {
    for (const kind of NOTIFICATION_TARGETS.keys()) {
      expect(kind, kind).toMatch(/^[a-z][a-z_]{0,39}$/);
    }
  });
});

describe("isEventId", () => {
  it("takes a lower-case UUID and nothing else", () => {
    expect(isEventId(EVENT)).toBe(true);
    for (const value of [null, undefined, 5, "", EVENT.toUpperCase(), `${EVENT} `, `/${EVENT}`]) {
      expect(isEventId(value), String(value)).toBe(false);
    }
    expect(isEventId([EVENT])).toBe(false);
  });
});

// Equivalent mutant left alive: eventRoute's `quest !== undefined` (an absent quest is tested as the text "undefined",
// which is no id either).
