import { describe, expect, it, vi } from "vitest";
import { openTap, responseKey, tapOf, type Tap, type TapIo } from "#src/push/tap.ts";

const EVENT = "5f0f2b0e-8c3e-4d7c-9a51-2a2f0b1c3d4e";
const QUEST = "0b9a7d3c-1f2e-4a5b-8c6d-7e8f9a0b1c2d";
const DEFAULT = "expo.modules.notifications.actions.DEFAULT";

/** The fields the server puts in a push (`message.data` in `pushMessageOf`): all text, `r` as JSON. */
const fields = (over: Record<string, string> = {}) => ({
  n: "123",
  k: "flash_quest",
  e: EVENT,
  r: JSON.stringify({ quest: QUEST }),
  ...over,
});

const responseOf = (request: Record<string, unknown>, action: string = DEFAULT) => ({
  actionIdentifier: action,
  notification: { date: 1_700_000_000, request: { identifier: "abc", ...request } },
});

const EXPECTED: Tap = {
  notificationId: 123,
  kind: "flash_quest",
  eventId: EVENT,
  refs: { quest: QUEST },
};

const idOf = (n: unknown) =>
  tapOf(responseOf({ content: { data: { ...fields(), n } } }))?.notificationId;
const eventOf = (e: unknown) =>
  tapOf(responseOf({ content: { data: { ...fields(), e } } }))?.eventId;
const refsOf = (r: unknown) => tapOf(responseOf({ content: { data: { ...fields(), r } } }))?.refs;
const io = (): TapIo => ({ open: vi.fn(), openCenter: vi.fn(), markRead: vi.fn() });

describe("where a tap's fields are read", () => {
  it("reads a direct APNs push from trigger.payload, under q, with content.data empty", () => {
    const response = responseOf({
      trigger: { type: "push", payload: { aps: { alert: { title: "t" } }, q: fields() } },
      content: { data: {} },
    });
    expect(tapOf(response)).toEqual(EXPECTED);
  });

  it("reads an FCM push from content.data, flat", () => {
    expect(tapOf(responseOf({ trigger: { type: "push" }, content: { data: fields() } }))).toEqual(
      EXPECTED,
    );
  });

  it("reads an FCM push from remoteMessage.data when content.data holds nothing", () => {
    const response = responseOf({
      trigger: { type: "push", remoteMessage: { data: fields() } },
      content: { data: null },
    });
    expect(tapOf(response)).toEqual(EXPECTED);
  });

  it("reads q given as JSON text, and fields in content.data under q", () => {
    expect(
      tapOf(responseOf({ trigger: { type: "push", payload: { q: JSON.stringify(fields()) } } })),
    ).toEqual(EXPECTED);
    expect(tapOf(responseOf({ content: { data: { q: fields() } } }))).toEqual(EXPECTED);
  });

  it("takes the first place that holds a valid kind", () => {
    const response = responseOf({
      trigger: {
        type: "push",
        payload: { q: { k: "BAD KIND" } },
        remoteMessage: { data: fields() },
      },
    });
    expect(tapOf(response)?.kind).toBe("flash_quest");
  });
});

describe("what a tap must be", () => {
  it("is nothing for another app's push, an empty payload or a response that is not an object", () => {
    for (const response of [
      null,
      undefined,
      "tap",
      5,
      {},
      responseOf({}),
      responseOf({ content: { data: { url: "https://example.com" } } }),
      responseOf({ trigger: { type: "push", payload: { aps: {} } } }),
    ]) {
      expect(tapOf(response)).toBeNull();
    }
  });

  it("is nothing for a dismissal or a custom action; a missing action id counts as the tap", () => {
    const request = { content: { data: fields() } };
    expect(tapOf(responseOf(request, "expo.modules.notifications.actions.DISMISS"))).toBeNull();
    expect(tapOf(responseOf(request, "reply"))).toBeNull();
    const { actionIdentifier: _dropped, ...withoutAction } = responseOf(request);
    expect(tapOf(withoutAction)).toEqual(EXPECTED);
  });

  it.each(["", "Flash", "flash-quest", "1flash", "x".repeat(41), "flash quest"])(
    "refuses the kind %j",
    (kind) => {
      expect(tapOf(responseOf({ content: { data: fields({ k: kind }) } }))).toBeNull();
    },
  );

  it("keeps a notification id only when it is a positive whole number", () => {
    expect(idOf("42")).toBe(42);
    expect(idOf(42)).toBe(42);
    for (const bad of ["0", "-1", "1.5", "abc", "", "9".repeat(16), null, undefined, {}]) {
      expect(idOf(bad), String(bad)).toBeNull();
    }
  });

  it("keeps an event id only when it is a UUID", () => {
    expect(eventOf(EVENT)).toBe(EVENT);
    for (const bad of ["", "5", "../admin", `${EVENT}/x`, EVENT.toUpperCase(), null, 7]) {
      expect(eventOf(bad), String(bad)).toBeNull();
    }
  });

  it("keeps reference ids only: names and UUIDs or whole numbers, nothing else", () => {
    expect(refsOf(JSON.stringify({ quest: QUEST, place: 3, ticket: "42" }))).toEqual({
      quest: QUEST,
      place: "3",
      ticket: "42",
    });
    expect(refsOf({ quest: QUEST })).toEqual({ quest: QUEST });
    expect(
      refsOf(
        JSON.stringify({
          quest: "https://example.com",
          Bad: "1",
          note: "free text",
          nested: { a: 1 },
          list: [1],
        }),
      ),
    ).toEqual({});
    for (const bad of ["not json", "[1]", "5", "null", undefined]) {
      expect(refsOf(bad), String(bad)).toEqual({});
    }
  });
});

describe("responseKey", () => {
  it("names a response by its notification and time, and nothing when it has none", () => {
    expect(responseKey(responseOf({ content: {} }))).toBe("abc@1700000000");
    expect(responseKey({ notification: { request: { identifier: "x" } } })).toBe("x@");
    expect(responseKey({})).toBeNull();
    expect(responseKey(null)).toBeNull();
  });
});

describe("openTap", () => {
  it("marks the row read and opens the screen the kind's route names", () => {
    const calls = io();
    openTap(EXPECTED, calls);
    expect(calls.markRead).toHaveBeenCalledExactlyOnceWith(123);
    expect(calls.open).toHaveBeenCalledExactlyOnceWith(`/event/${EVENT}/quests?quest=${QUEST}`);
    expect(calls.openCenter).not.toHaveBeenCalled();
  });

  it.each([
    ["a promotion", { ...EXPECTED, kind: "invitation" }],
    ["a kind this app does not know", { ...EXPECTED, kind: "from_a_newer_app" }],
    ["an event kind with no valid event", { ...EXPECTED, eventId: null }],
  ])("opens the center on the row for %s", (_name, tap) => {
    const calls = io();
    openTap(tap, calls);
    expect(calls.openCenter).toHaveBeenCalledExactlyOnceWith(123);
    expect(calls.open).not.toHaveBeenCalled();
  });

  it("marks nothing read and opens the bare center when the push named no row", () => {
    const calls = io();
    openTap({ ...EXPECTED, notificationId: null, kind: "invitation" }, calls);
    expect(calls.markRead).not.toHaveBeenCalled();
    expect(calls.openCenter).toHaveBeenCalledExactlyOnceWith(null);
  });
});
