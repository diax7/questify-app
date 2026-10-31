import { describe, expect, it } from "vitest";
import {
  completionRate,
  controlViewOf,
  methodLabelOf,
  roomEventOf,
} from "#src/lib/control-room.ts";

const item = {
  id: "9",
  at: "2030-11-01T10:00:00.000Z",
  questId: "q1",
  title: { ar: null, en: "Find the stage" },
  method: "qr",
  username: "nora",
  avatar: "fox",
};
const counts = { players: 10, online: 3, lowStock: 1, inbox: 2, flags: 0 };

describe("controlViewOf", () => {
  it("reads the API's answer", () => {
    const view = controlViewOf({ counts, feed: [item], done: { q1: 4 } });
    expect(view).toEqual({ counts, feed: [item], done: { q1: 4 } });
  });

  it("accepts a quiet event", () => {
    expect(controlViewOf({ counts, feed: [], done: {} })).toEqual({ counts, feed: [], done: {} });
  });

  it.each([
    ["not an object", "nope"],
    ["no counts", { feed: [], done: {} }],
    ["a missing counter", { counts: { ...counts, flags: undefined }, feed: [], done: {} }],
    ["a counter that is text", { counts: { ...counts, inbox: "2" }, feed: [], done: {} }],
    ["a feed that is not a list", { counts, feed: {}, done: {} }],
    ["a feed row without a username", { counts, feed: [{ ...item, username: 5 }], done: {} }],
    ["a title that is not bilingual", { counts, feed: [{ ...item, title: "x" }], done: {} }],
    ["done as a list", { counts, feed: [], done: [] }],
    ["a done count that is text", { counts, feed: [], done: { q1: "4" } }],
  ])("refuses %s", (_name, body) => {
    expect(controlViewOf(body)).toBeUndefined();
  });
});

describe("completionRate", () => {
  it("rounds to a whole percent of the players", () => {
    expect(completionRate(1, 3)).toBe(33);
    expect(completionRate(2, 3)).toBe(67);
    expect(completionRate(610, 1245)).toBe(49);
  });

  it("is 0 for a quest nobody completed and for an event nobody joined", () => {
    expect(completionRate(undefined, 10)).toBe(0);
    expect(completionRate(0, 10)).toBe(0);
    expect(completionRate(5, 0)).toBe(0);
  });

  it("never goes over 100", () => {
    expect(completionRate(12, 10)).toBe(100);
  });
});

describe("methodLabelOf", () => {
  it("names the station methods, and calls every other action an in-app one", () => {
    expect(methodLabelOf("qr")).toBe("control.method.qr");
    expect(methodLabelOf("my_qr")).toBe("control.method.operator");
    expect(methodLabelOf("kiosk")).toBe("control.method.kiosk");
    expect(methodLabelOf("manual")).toBe("control.method.manual");
    expect(methodLabelOf("quiz")).toBe("control.method.app");
    expect(methodLabelOf("something_new")).toBe("control.method.app");
  });
});

describe("roomEventOf", () => {
  const event = { timezone: "Asia/Dubai", statusNow: "live", flashQuests: true, boosts: true };

  it("reads the event's clock, whether it is over and its two switches", () => {
    expect(roomEventOf(event)).toEqual({
      timeZone: "Asia/Dubai",
      closed: false,
      flashOn: true,
      boostsOn: true,
    });
    expect(roomEventOf({ ...event, flashQuests: false, boosts: false })).toMatchObject({
      flashOn: false,
      boostsOn: false,
    });
  });

  it("calls an ended or archived event closed, and a draft, scheduled or live one open", () => {
    expect(roomEventOf({ ...event, statusNow: "ended" }).closed).toBe(true);
    expect(roomEventOf({ ...event, statusNow: "archived" }).closed).toBe(true);
    for (const statusNow of ["draft", "scheduled", "live"]) {
      expect(roomEventOf({ ...event, statusNow }).closed, statusNow).toBe(false);
    }
  });

  it("starts open on the Riyadh clock with every switch on, before the event has loaded", () => {
    expect(roomEventOf(null)).toEqual({
      timeZone: "Asia/Riyadh",
      closed: false,
      flashOn: true,
      boostsOn: true,
    });
  });
});
