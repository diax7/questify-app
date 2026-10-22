import { describe, expect, it } from "vitest";
import {
  addonName,
  limitBanner,
  limitLine,
  readActivation,
  type ActivationView,
} from "#src/lib/activation.ts";
import {
  limitBodyOf,
  missingField,
  nameIn,
  readConsoleEvent,
  readQueue,
} from "#src/lib/console.ts";

const VIEW: ActivationView = {
  state: "activated",
  requestedAt: null,
  note: null,
  limit: { mode: "hard", value: 300 },
  players: 240,
  alerts: [80],
  addons: ["bigScreen"],
};

const bracketed = (key: string) => `[${key}]`;
const incomplete = (field: unknown) => ({ code: "activation_incomplete", details: { field } });

describe("readActivation", () => {
  it("takes the API's answer as it is", () => {
    expect(readActivation(VIEW)).toEqual(VIEW);
    expect(
      readActivation({ ...VIEW, state: "requested", requestedAt: "2026-10-22T09:00:00Z" }),
    ).toBeDefined();
  });

  it("refuses a changed answer", () => {
    for (const broken of [
      null,
      "x",
      { ...VIEW, state: "paid" },
      { ...VIEW, requestedAt: 5 },
      { ...VIEW, note: 5 },
      { ...VIEW, limit: null },
      { ...VIEW, limit: { mode: "huge", value: 1 } },
      { ...VIEW, limit: { mode: "hard", value: "300" } },
      { ...VIEW, players: "240" },
      { ...VIEW, alerts: ["80"] },
      { ...VIEW, alerts: null },
      { ...VIEW, addons: [1] },
    ]) {
      expect(readActivation(broken), JSON.stringify(broken)).toBeUndefined();
    }
  });
});

describe("limit words", () => {
  it("names the limit by its mode", () => {
    expect(limitLine(VIEW)).toEqual({ key: "activation.limit.hard", params: { limit: 300 } });
    expect(limitLine({ ...VIEW, limit: { mode: "soft", value: 50 } })).toEqual({
      key: "activation.limit.soft",
      params: { limit: 50 },
    });
    expect(limitLine({ ...VIEW, limit: { mode: "none", value: null } })).toEqual({
      key: "activation.limit.none",
      params: {},
    });
  });

  it("shows the highest mark reached, and nothing without a limit or a mark", () => {
    expect(limitBanner(VIEW)).toEqual({
      key: "activation.alert.near",
      params: { count: 240, limit: 300 },
    });
    expect(limitBanner({ ...VIEW, alerts: [80, 100], players: 300 })).toEqual({
      key: "activation.alert.fullHard",
      params: { count: 300, limit: 300 },
    });
    expect(
      limitBanner({ ...VIEW, limit: { mode: "soft", value: 300 }, alerts: [80, 100] })?.key,
    ).toBe("activation.alert.fullSoft");
    expect(limitBanner({ ...VIEW, alerts: [] })).toBeUndefined();
    expect(limitBanner({ ...VIEW, limit: { mode: "none", value: null } })).toBeUndefined();
  });

  it("names known add-ons and shows an unknown one by its key", () => {
    expect(addonName("bigScreen", bracketed)).toBe("[addon.bigScreen]");
    expect(addonName("kiosks", bracketed)).toBe("kiosks");
  });
});

describe("console helpers", () => {
  const event = {
    ...VIEW,
    event: {
      id: "e1",
      joinCode: "SPRING",
      name: { ar: null, en: "Spring" },
      status: "draft",
      statusNow: "draft",
      timezone: "Asia/Riyadh",
      startsAt: null,
      endsAt: null,
      organizer: { id: "o1", name: "Najd" },
      ownerEmail: "owner@najd.sa",
    },
  };

  it("reads the queue and the event, and refuses changed answers", () => {
    const row = {
      eventId: "e1",
      name: { ar: "ربيع", en: null },
      organizer: "Najd",
      requestedAt: "2026-10-22T09:00:00Z",
      startsAt: null,
      timezone: "Asia/Riyadh",
    };
    expect(readQueue({ requests: [row] })).toEqual([row]);
    expect(readQueue({ requests: [{ ...row, organizer: 1 }] })).toBeUndefined();
    expect(readQueue({ requests: [{ ...row, name: { ar: 1, en: null } }] })).toBeUndefined();
    expect(readQueue({})).toBeUndefined();
    expect(readConsoleEvent(event)).toEqual(event);
    expect(
      readConsoleEvent({ ...event, event: { ...event.event, ownerEmail: 3 } }),
    ).toBeUndefined();
    expect(
      readConsoleEvent({ ...event, event: { ...event.event, organizer: null } }),
    ).toBeUndefined();
    expect(readConsoleEvent({ ...event, state: "paid" })).toBeUndefined();
    expect(readConsoleEvent(VIEW)).toBeUndefined();
  });

  it("names in the reader's language, else the other", () => {
    expect(nameIn({ ar: "ربيع", en: "Spring" }, "ar")).toBe("ربيع");
    expect(nameIn({ ar: null, en: "Spring" }, "ar")).toBe("Spring");
    expect(nameIn({ ar: "ربيع", en: null }, "en")).toBe("ربيع");
    expect(nameIn({ ar: null, en: null }, "en")).toBe("");
  });

  it("names what an event still needs, only for that refusal", () => {
    expect(missingField(incomplete("venue"))).toBe("venue");
    expect(missingField(incomplete("times"))).toBe("times");
    expect(missingField(incomplete("price"))).toBeUndefined();
    expect(missingField({ code: "activation_incomplete" })).toBeUndefined();
    expect(missingField({ code: "invalid_limit", details: { field: "venue" } })).toBeUndefined();
    expect(missingField(undefined)).toBeUndefined();
  });

  it("sends no number with none, and the typed number otherwise", () => {
    expect(limitBodyOf({ mode: "none", value: "300" })).toEqual({ mode: "none" });
    expect(limitBodyOf({ mode: "hard", value: " 300 " })).toEqual({ mode: "hard", value: 300 });
    expect(limitBodyOf({ mode: "soft", value: "" })).toEqual({ mode: "soft" });
  });
});
