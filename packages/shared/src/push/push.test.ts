import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  invalidPushDeviceSchema,
  notificationListSchema,
  notificationsQuerySchema,
  notificationsReadBodySchema,
  notificationsUnreadSchema,
  pushDeviceBodySchema,
  pushTopicsBodySchema,
  pushTopicsSchema,
} from "#src/push/push";

/*
 * Equivalent mutants left alive: the refine messages ("an iOS device names...", "not a device token", "name at least
 * one topic", "at most 50 a page") never leave the server; `parse` answers a bare invalid_request.
 */

const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;
const pathsOf = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value).error?.issues.map((issue) => issue.path);

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

  it("takes a token only whole: 20 to 2,048 FCM characters, 64 to 200 hex of either case", () => {
    expect(accepts(pushDeviceBodySchema, { ...android, token: "x".repeat(20) })).toBe(true);
    for (const token of ["x".repeat(19), `/${"x".repeat(20)}`, `${"x".repeat(20)}/`]) {
      expect(accepts(pushDeviceBodySchema, { ...android, token }), token).toBe(false);
    }
    for (const token of ["a".repeat(200), "0123456789abcdef".repeat(4)]) {
      expect(accepts(pushDeviceBodySchema, { ...ios, token }), token).toBe(true);
    }
    for (const token of [`-${IOS}`, `${IOS}-`]) {
      expect(accepts(pushDeviceBodySchema, { ...ios, token }), token).toBe(false);
    }
  });

  it("points a refusal at the field at fault", () => {
    expect(pathsOf(pushDeviceBodySchema, { ...ios, environment: undefined })).toEqual([
      ["environment"],
    ]);
    expect(pathsOf(pushDeviceBodySchema, { ...android, environment: "sandbox" })).toEqual([
      ["environment"],
    ]);
    expect(pathsOf(pushDeviceBodySchema, { ...ios, token: ANDROID })).toEqual([["token"]]);
    expect(pathsOf(pushDeviceBodySchema, { ...android, token: IOS.slice(0, 19) })).toEqual([
      ["token"],
    ]);
  });

  it("takes an app version of 1 to 20 characters", () => {
    expect(accepts(pushDeviceBodySchema, { ...android, appVersion: "1" })).toBe(true);
    expect(accepts(pushDeviceBodySchema, { ...android, appVersion: "1".repeat(20) })).toBe(true);
    expect(accepts(pushDeviceBodySchema, { ...android, appVersion: "1.4.0 beta" })).toBe(false);
  });

  it("names any of the five device fields in a 422, and nothing else", () => {
    for (const field of ["platform", "token", "environment", "language", "appVersion"]) {
      expect(invalidPushDeviceSchema.parse({ field }), field).toEqual({ field });
    }
    for (const value of [{}, { field: "playerId" }, { field: "token", token: IOS }]) {
      expect(accepts(invalidPushDeviceSchema, value), JSON.stringify(value)).toBe(false);
    }
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
    expect(notificationsQuerySchema.parse({ before: "9".repeat(15), limit: "1" })).toEqual({
      before: 999_999_999_999_999,
      limit: 1,
    });
    expect(notificationsQuerySchema.parse({ before: "120", limit: "50" })).toEqual({
      before: 120,
      limit: 50,
    });
    for (const query of [
      { limit: "51" },
      { limit: "0" },
      { before: "-1" },
      { before: "1.5" },
      { before: "1".repeat(16) },
      { before: "01" },
      { page: "2" },
    ]) {
      expect(accepts(notificationsQuerySchema, query), JSON.stringify(query)).toBe(false);
    }
  });

  it("marks 1 to 100 ids, or all", () => {
    expect(notificationsReadBodySchema.parse({ ids: [1, 2] })).toEqual({ ids: [1, 2] });
    expect(notificationsReadBodySchema.parse({ all: true })).toEqual({ all: true });
    const hundredOne = Array.from({ length: 101 }, (_, i) => i + 1);
    expect(accepts(notificationsReadBodySchema, { ids: hundredOne.slice(1) })).toBe(true);
    expect(accepts(notificationsReadBodySchema, { ids: [Number.MAX_SAFE_INTEGER] })).toBe(true);
    for (const body of [
      { ids: [Number.MAX_SAFE_INTEGER + 1] },
      { ids: [1.5] },
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
      joinCode: null,
    };
    expect(
      notificationListSchema.parse({ items: [item], nextBefore: null, unread: 1 }),
    ).toBeTruthy();
    const withCode = (joinCode: unknown) =>
      accepts(notificationListSchema, {
        items: [{ ...item, joinCode }],
        nextBefore: null,
        unread: 1,
      });
    expect(withCode("WINTER26")).toBe(true);
    for (const code of ["W-26", "abc", "https://x.io", "A".repeat(13), 1234, undefined]) {
      expect(withCode(code), String(code)).toBe(false);
    }
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

  it("keeps a row's kind to a whole lower-case name of up to 40 characters", () => {
    const item = {
      id: 7,
      kind: "flash_quest",
      topic: null,
      eventId: null,
      refs: {},
      title: "Winter Fest",
      body: "Flash quest",
      createdAt: "2026-10-28T10:00:00.000Z",
      read: false,
      optOut: false,
      joinCode: null,
    };
    const list = (kind: string) => ({ items: [{ ...item, kind }], nextBefore: null, unread: 0 });
    expect(accepts(notificationListSchema, list(`a${"_".repeat(39)}`))).toBe(true);
    for (const kind of [`a${"_".repeat(40)}`, "Xflash", "flash!", "_flash", ""]) {
      expect(accepts(notificationListSchema, list(kind)), kind).toBe(false);
    }
  });

  it("holds 50 rows a page and an unread count of 0 to 100", () => {
    const item = {
      id: 7,
      kind: "flash_quest",
      topic: null,
      eventId: null,
      refs: {},
      title: "Winter Fest",
      body: "Flash quest",
      createdAt: "2026-10-28T10:00:00.000Z",
      read: false,
      optOut: false,
      joinCode: null,
    };
    const page = (size: number) => ({
      items: Array.from({ length: size }, () => item),
      nextBefore: 7,
      unread: 100,
    });
    expect(accepts(notificationListSchema, page(50))).toBe(true);
    expect(accepts(notificationListSchema, page(51))).toBe(false);
    expect(accepts(notificationListSchema, { ...page(0), nextBefore: 0 })).toBe(false);
    for (const unread of [0, 100]) {
      expect(notificationsUnreadSchema.parse({ unread }), String(unread)).toEqual({ unread });
    }
    for (const value of [
      {},
      { unread: -1 },
      { unread: 101 },
      { unread: 1.5 },
      { unread: 1, all: true },
    ]) {
      expect(accepts(notificationsUnreadSchema, value), JSON.stringify(value)).toBe(false);
    }
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
      joinCode: null,
    };
    const list = (refs: unknown) => ({ items: [{ ...item, refs }], nextBefore: null, unread: 0 });
    expect(accepts(notificationListSchema, list({ quest: "123456789012345678" }))).toBe(true);
    expect(accepts(notificationListSchema, list({ [`q${"A".repeat(30)}`]: "5" }))).toBe(true);
    for (const refs of [
      { quest: "free text" },
      { quest: 5 },
      { Quest: "5" },
      { quest: "1234567890123456789" },
      { quest: ["5"] },
      { [`q${"A".repeat(31)}`]: "5" },
      { quest: "5F0F2B0E-8C3E-4D7C-9A51-2A2F0B1C3D4E" },
      null,
    ]) {
      expect(accepts(notificationListSchema, list(refs)), JSON.stringify(refs)).toBe(false);
    }
  });
});
