import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import {
  CENTER_PAGE_SIZE,
  fetchCenterPage,
  fetchTopics,
  fetchUnread,
  markNotificationsRead,
  refreshUnread,
  saveTopics,
} from "#src/push/push-api.ts";
import { getUnread, setUnread } from "#src/push/unread-store.ts";

const ok = (body: unknown): AuthedResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(),
});
const refused = (status: number): AuthedResult => ({
  kind: "error",
  status,
  code: "invalid_request",
  message: null,
  details: {},
  headers: new Headers(),
});
const sessionOf = (...answers: AuthedResult[]) => {
  const request = vi.fn();
  for (const answer of answers) request.mockResolvedValueOnce(answer);
  return { request };
};

const ITEM = {
  id: 7,
  kind: "flash_quest",
  topic: "announcements",
  eventId: "5f0f2b0e-8c3e-4d7c-9a51-2a2f0b1c3d4e",
  refs: { quest: "42" },
  title: "Winter Fest",
  body: "Flash quest",
  createdAt: "2026-10-28T10:00:00.000Z",
  read: false,
  optOut: false,
};
const TOPICS = { announcements: true, rank: false, community: true, reminders: true };

describe("the center", () => {
  it("asks for the newest page, then for the page before a cursor", async () => {
    const session = sessionOf(
      ok({ items: [ITEM], nextBefore: 7, unread: 3 }),
      ok({ items: [], nextBefore: null, unread: 3 }),
    );
    expect(await fetchCenterPage(session, null)).toEqual({
      items: [ITEM],
      nextBefore: 7,
      unread: 3,
    });
    await fetchCenterPage(session, 7);
    expect(session.request.mock.calls.map(([call]) => call)).toEqual([
      { method: "GET", path: `/v1/me/notifications?limit=${CENTER_PAGE_SIZE}` },
      { method: "GET", path: `/v1/me/notifications?limit=${CENTER_PAGE_SIZE}&before=7` },
    ]);
  });

  it("is null, never an empty center, for a failed or odd answer", async () => {
    expect(await fetchCenterPage(sessionOf({ kind: "network" }), null)).toBeNull();
    expect(await fetchCenterPage(sessionOf(refused(500)), null)).toBeNull();
    expect(await fetchCenterPage(sessionOf(ok({ items: "x" })), null)).toBeNull();
    expect(
      await fetchCenterPage(
        sessionOf(
          ok({ items: [{ ...ITEM, refs: { quest: "free text" } }], nextBefore: null, unread: 0 }),
        ),
        null,
      ),
    ).toBeNull();
  });
});

describe("the unread count alone", () => {
  it("reads one row of the center and keeps only the count", async () => {
    const session = sessionOf(ok({ items: [ITEM], nextBefore: null, unread: 5 }));
    expect(await fetchUnread(session)).toBe(5);
    expect(session.request).toHaveBeenCalledExactlyOnceWith({
      method: "GET",
      path: "/v1/me/notifications?limit=1",
    });
  });

  it("is null for a failed or odd answer", async () => {
    expect(await fetchUnread(sessionOf({ kind: "network" }))).toBeNull();
    expect(await fetchUnread(sessionOf(refused(503)))).toBeNull();
    expect(await fetchUnread(sessionOf(ok({ unread: 5 })))).toBeNull();
  });

  describe("refreshing the bell", () => {
    afterEach(() => setUnread(0));

    it("sets the count the server gave", async () => {
      setUnread(1);
      await refreshUnread(sessionOf(ok({ items: [], nextBefore: null, unread: 7 })));
      expect(getUnread()).toBe(7);
    });

    it("leaves the count as it was when the read fails, offline or on a server error", async () => {
      setUnread(4);
      await refreshUnread(sessionOf({ kind: "network" }));
      await refreshUnread(sessionOf(refused(500)));
      await refreshUnread(sessionOf({ kind: "signed_out" }));
      expect(getUnread()).toBe(4);
    });
  });
});

describe("marking read", () => {
  it("sends the ids or all, and answers the unread count after", async () => {
    const session = sessionOf(ok({ unread: 2 }), ok({ unread: 0 }));
    expect(await markNotificationsRead(session, { ids: [7, 8] })).toBe(2);
    expect(await markNotificationsRead(session, { all: true })).toBe(0);
    expect(session.request.mock.calls.map(([call]) => call)).toEqual([
      { method: "POST", path: "/v1/me/notifications/read", body: { ids: [7, 8] } },
      { method: "POST", path: "/v1/me/notifications/read", body: { all: true } },
    ]);
  });

  it("is null when the call failed or the answer is odd", async () => {
    expect(await markNotificationsRead(sessionOf({ kind: "network" }), { all: true })).toBeNull();
    expect(await markNotificationsRead(sessionOf(refused(400)), { ids: [1] })).toBeNull();
    expect(await markNotificationsRead(sessionOf(ok({ unread: 101 })), { all: true })).toBeNull();
  });
});

describe("the topics", () => {
  it("reads the four topics", async () => {
    const session = sessionOf(ok(TOPICS));
    expect(await fetchTopics(session)).toEqual(TOPICS);
    expect(session.request).toHaveBeenCalledExactlyOnceWith({
      method: "GET",
      path: "/v1/me/push-topics",
    });
  });

  it("changes the topics named and answers all four", async () => {
    const session = sessionOf(ok(TOPICS));
    expect(await saveTopics(session, { rank: false })).toEqual(TOPICS);
    expect(session.request).toHaveBeenCalledExactlyOnceWith({
      method: "PUT",
      path: "/v1/me/push-topics",
      body: { rank: false },
    });
  });

  it("is null when unreadable or when the save failed, so nothing is assumed saved", async () => {
    expect(await fetchTopics(sessionOf(ok({ announcements: true })))).toBeNull();
    expect(await fetchTopics(sessionOf({ kind: "network" }))).toBeNull();
    expect(await saveTopics(sessionOf(refused(429)), { rank: true })).toBeNull();
    expect(await saveTopics(sessionOf(ok({ rank: true })), { rank: true })).toBeNull();
  });
});
