import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  centerItem,
  markRead,
  pushRefusal,
  readCenter,
  readUnread,
  registerDevice,
  setTopics,
} from "#src/push/center";
import { HttpError } from "#src/http-error";
import { pgError } from "#test/support/fake-pool";

/** A client that answers each query from `answer` and keeps what it was sent. */
const clientOf = (answer: (sql: string, values: readonly unknown[]) => unknown) => {
  const sent: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      sent.push({ sql, values });
      return { rows: [{ r: await answer(sql, values) }] };
    },
  } as unknown as PoolClient;
  return { client, sent };
};

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  kind: "no_template_kind",
  class: "personal" as const,
  topic: null,
  eventId: null,
  refs: {},
  params: { event: { ar: "مهرجان", en: "Fest" } },
  createdAt: "2026-10-28T10:00:00.123456+00:00",
  read: false,
  terms: null,
  timezone: "Asia/Riyadh",
  ...over,
});

const refusalOf = (error: unknown): HttpError | unknown => {
  try {
    pushRefusal(error);
  } catch (thrown) {
    return thrown;
  }
  return undefined;
};

describe("pushRefusal", () => {
  it("maps the doors' codes and rethrows anything else", () => {
    expect(refusalOf(pgError({ code: "PN401" }))).toMatchObject({
      status: 401,
      envelope: { code: "unauthenticated" },
    });
    expect(refusalOf(pgError({ code: "PN422", detail: "environment" }))).toMatchObject({
      status: 422,
      envelope: { code: "invalid_push_device", details: { field: "environment" } },
    });
    expect(refusalOf(pgError({ code: "PN422", detail: "ids" }))).toMatchObject({
      status: 400,
      envelope: { code: "invalid_request" },
    });
    const other = pgError({ code: "57P01" });
    expect(refusalOf(other)).toBe(other);
  });

  it("names each device field the door refuses, and only for the door's own code", () => {
    for (const field of ["platform", "token", "environment", "language", "appVersion"]) {
      expect(refusalOf(pgError({ code: "PN422", detail: field })), field).toMatchObject({
        status: 422,
        envelope: { code: "invalid_push_device", details: { field } },
      });
    }
    // A detail-less PN422 is a plain invalid request (the `detail ?? ""` fallback's mutant is equivalent: no field is "").
    expect(refusalOf(pgError({ code: "PN422" }))).toMatchObject({ status: 400 });
    const unique = pgError({ code: "23505", detail: "token" });
    expect(refusalOf(unique)).toBe(unique);
  });

  it("maps a door's refusal raised mid-query", async () => {
    const refused = {
      query: () => Promise.reject(pgError({ code: "PN401" })),
    } as unknown as PoolClient;
    await expect(readCenter(refused, { before: null, limit: 20 }, "en")).rejects.toMatchObject({
      status: 401,
      envelope: { code: "unauthenticated" },
    });
  });
});

describe("the center", () => {
  it("renders a row in the asked language, marks a promotion with its opt-out and normalizes the time", () => {
    expect(centerItem(row(4), "en")).toEqual({
      id: 4,
      kind: "no_template_kind",
      topic: null,
      eventId: null,
      refs: {},
      title: "Fest",
      body: "You have a new message",
      createdAt: "2026-10-28T10:00:00.123Z",
      read: false,
      optOut: false,
    });
    expect(centerItem(row(4, { class: "promo", read: true }), "ar")).toMatchObject({
      title: "مهرجان",
      body: "لديك رسالة جديدة",
      optOut: true,
      read: true,
    });
  });

  it("carries the notice's reference ids and nothing else of its refs", () => {
    const quest = "5f0f2b0e-8c3e-4d7c-9a51-2a2f0b1c3d4e";
    const item = centerItem(
      row(5, { refs: { quest, place: 3, note: "free text", Bad: quest, ok: { nested: quest } } }),
      "en",
    );
    expect(item.refs).toEqual({ quest, place: "3" });
    expect(centerItem(row(6, { refs: null }), "en").refs).toEqual({});
  });

  it("gives the next cursor only when the page is full", async () => {
    const full = clientOf((sql) => (sql.includes("own_notifications") ? [row(9), row(8)] : 3));
    expect(await readCenter(full.client, { before: null, limit: 2 }, "en")).toMatchObject({
      nextBefore: 8,
      unread: 3,
    });
    expect(full.sent[0]?.values).toEqual([null, 2]);
    const three = clientOf((sql) =>
      sql.includes("own_notifications") ? [row(9), row(8), row(7)] : 3,
    );
    expect(await readCenter(three.client, { before: null, limit: 3 }, "en")).toMatchObject({
      nextBefore: 7,
    });
    const none = clientOf((sql) => (sql.includes("own_notifications") ? [] : 0));
    expect(await readCenter(none.client, { before: null, limit: 0 }, "en")).toMatchObject({
      nextBefore: null,
    });
    const short = clientOf((sql) => (sql.includes("own_notifications") ? [row(9)] : 0));
    expect(await readCenter(short.client, { before: 20, limit: 2 }, "ar")).toMatchObject({
      items: [{ id: 9, title: "مهرجان" }],
      nextBefore: null,
      unread: 0,
    });
    const empty = clientOf((sql) => (sql.includes("own_notifications") ? [] : null));
    expect(await readCenter(empty.client, { before: 1, limit: 20 }, "en")).toEqual({
      items: [],
      nextBefore: null,
      unread: 0,
    });
    expect(await readUnread(clientOf(() => null).client)).toBe(0);
  });

  it("marks the named rows or all of them", async () => {
    const one = clientOf(() => 4);
    expect(await markRead(one.client, [3, 5])).toBe(4);
    expect(one.sent[0]?.values).toEqual([[3, 5]]);
    const all = clientOf(() => 0);
    await markRead(all.client, null);
    expect(all.sent[0]?.values).toEqual([null]);
  });

  it("changes the topics named and keeps the others", async () => {
    const current = { announcements: true, rank: false, community: true, reminders: true };
    const topics = clientOf((sql) => (sql.includes("own_push_topics") ? current : { ok: true }));
    await setTopics(topics.client, { rank: true, reminders: false });
    expect(topics.sent[1]?.values).toEqual([["reminders"]]);
  });

  it("registers with the session's hash, an absent environment as null", async () => {
    const door = clientOf(() => null);
    const session = Buffer.alloc(32, 1);
    await registerDevice(door.client, session, {
      platform: "android",
      token: "fcm_token_1234567890",
      language: "en",
      appVersion: "1.0.0",
    });
    expect(door.sent[0]?.values).toEqual([
      session,
      "android",
      "fcm_token_1234567890",
      null,
      "en",
      "1.0.0",
    ]);
  });
});
