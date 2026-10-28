import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  notificationListSchema,
  notificationsQuerySchema,
  notificationsReadBodySchema,
  pushDeviceBodySchema,
  pushTopicsBodySchema,
  pushTopicsSchema,
} from "#src/push/push";

const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const IOS = "A".repeat(64);
const ANDROID = "fcm-token_abc:DEF-123456";

describe("pushDeviceBodySchema", () => {
  const ios = {
    platform: "ios",
    token: IOS,
    environment: "production",
    language: "ar",
    appVersion: "1.4.0",
  };
  const android = { platform: "android", token: ANDROID, language: "en", appVersion: "1.4.0" };

  it("takes an iOS device with its environment and an Android one without", () => {
    expect(pushDeviceBodySchema.parse(ios)).toEqual(ios);
    expect(pushDeviceBodySchema.parse({ ...ios, environment: "sandbox" })).toMatchObject({
      environment: "sandbox",
    });
    expect(pushDeviceBodySchema.parse(android)).toEqual(android);
  });

  it("refuses an iOS device without an environment and an Android one with one", () => {
    expect(accepts(pushDeviceBodySchema, { ...ios, environment: undefined })).toBe(false);
    expect(accepts(pushDeviceBodySchema, { ...android, environment: "production" })).toBe(false);
    expect(accepts(pushDeviceBodySchema, { ...ios, environment: "staging" })).toBe(false);
  });

  it("refuses tokens of the wrong shape or length", () => {
    for (const token of ["a".repeat(63), "g".repeat(64), "a".repeat(201)]) {
      expect(accepts(pushDeviceBodySchema, { ...ios, token }), token).toBe(false);
    }
    for (const token of [
      "short",
      "has space in it here",
      "x".repeat(2049),
      "tok/with/slash/abcdef",
    ]) {
      expect(accepts(pushDeviceBodySchema, { ...android, token }), token).toBe(false);
    }
    expect(accepts(pushDeviceBodySchema, { ...android, token: "x".repeat(2048) })).toBe(true);
  });

  it("refuses an unknown platform, language, version or field", () => {
    expect(accepts(pushDeviceBodySchema, { ...android, platform: "web" })).toBe(false);
    expect(accepts(pushDeviceBodySchema, { ...android, language: "fr" })).toBe(false);
    expect(accepts(pushDeviceBodySchema, { ...android, appVersion: "" })).toBe(false);
    expect(accepts(pushDeviceBodySchema, { ...android, appVersion: "1".repeat(21) })).toBe(false);
    expect(accepts(pushDeviceBodySchema, { ...android, playerId: "x" })).toBe(false);
  });
});

describe("the topics", () => {
  it("answers all four and takes any named subset", () => {
    const all = { announcements: true, rank: false, community: true, reminders: true };
    expect(pushTopicsSchema.parse(all)).toEqual(all);
    expect(accepts(pushTopicsSchema, { ...all, offers: true })).toBe(false);
    expect(pushTopicsBodySchema.parse({ rank: false })).toEqual({ rank: false });
    expect(accepts(pushTopicsBodySchema, {})).toBe(false);
    expect(accepts(pushTopicsBodySchema, { rank: "off" })).toBe(false);
    expect(accepts(pushTopicsBodySchema, { personal: false })).toBe(false);
  });
});

describe("the center", () => {
  it("reads a page's cursor and size", () => {
    expect(notificationsQuerySchema.parse({})).toEqual({ before: null, limit: 20 });
    expect(notificationsQuerySchema.parse({ before: "120", limit: "50" })).toEqual({
      before: 120,
      limit: 50,
    });
    for (const query of [
      { limit: "51" },
      { limit: "0" },
      { before: "-1" },
      { before: "1.5" },
      { page: "2" },
    ]) {
      expect(accepts(notificationsQuerySchema, query), JSON.stringify(query)).toBe(false);
    }
  });

  it("marks 1 to 100 ids, or all", () => {
    expect(notificationsReadBodySchema.parse({ ids: [1, 2] })).toEqual({ ids: [1, 2] });
    expect(notificationsReadBodySchema.parse({ all: true })).toEqual({ all: true });
    const hundredOne = Array.from({ length: 101 }, (_, i) => i + 1);
    for (const body of [
      { ids: [] },
      { ids: hundredOne },
      { ids: [0] },
      { all: false },
      { ids: [1], all: true },
    ]) {
      expect(accepts(notificationsReadBodySchema, body), JSON.stringify(body).slice(0, 40)).toBe(
        false,
      );
    }
  });

  it("answers rendered rows with ids only besides the text", () => {
    const item = {
      id: 7,
      kind: "join_accepted",
      topic: null,
      eventId: "5f0f2b0e-8c3e-4d7c-9a51-2a2f0b1c3d4e",
      refs: { quest: "5f0f2b0e-8c3e-4d7c-9a51-2a2f0b1c3d4e", place: "3" },
      title: "Winter Fest",
      body: "Your request to join was accepted.",
      createdAt: "2026-10-28T10:00:00.000Z",
      read: false,
      optOut: false,
    };
    expect(
      notificationListSchema.parse({ items: [item], nextBefore: null, unread: 1 }),
    ).toBeTruthy();
    expect(
      accepts(notificationListSchema, {
        items: [{ ...item, playerId: "x" }],
        nextBefore: null,
        unread: 1,
      }),
    ).toBe(false);
    expect(
      accepts(notificationListSchema, {
        items: [{ ...item, topic: "offers" }],
        nextBefore: null,
        unread: 1,
      }),
    ).toBe(false);
    expect(accepts(notificationListSchema, { items: [], nextBefore: null, unread: 101 })).toBe(
      false,
    );
  });

  it("keeps a row's refs to names and ids", () => {
    const item = {
      id: 7,
      kind: "flash_quest",
      topic: "announcements",
      eventId: null,
      refs: {},
      title: "Winter Fest",
      body: "Flash quest",
      createdAt: "2026-10-28T10:00:00.000Z",
      read: true,
      optOut: false,
    };
    const list = (refs: unknown) => ({ items: [{ ...item, refs }], nextBefore: null, unread: 0 });
    expect(accepts(notificationListSchema, list({ quest: "123456789012345678" }))).toBe(true);
    for (const refs of [
      { quest: "free text" },
      { quest: 5 },
      { Quest: "5" },
      { quest: "1234567890123456789" },
      { quest: ["5"] },
      null,
    ]) {
      expect(accepts(notificationListSchema, list(refs)), JSON.stringify(refs)).toBe(false);
    }
  });
});
