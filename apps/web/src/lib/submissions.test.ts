import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  FILTERS,
  PHOTO_REFRESH,
  canGiveReason,
  photoRefreshDelay,
  showsEmpty,
  showsMarkSeen,
  statusKey,
  withoutItems,
  type QueueItem,
} from "#src/lib/submissions.ts";

const item = (id: string): QueueItem => ({
  id,
  questId: "q",
  questTitle: { ar: null, en: "Quest" },
  enrollmentId: "e",
  username: "sam",
  avatar: "fox",
  text: "hello",
  points: 5,
  status: "approved",
  auto: true,
  marked: false,
  reason: null,
  reasonSystem: false,
  createdAt: "2026-11-07T10:00:00Z",
  reviewedAt: null,
  seenAt: null,
});

describe("the submissions queue", () => {
  it("names each status and each tab in both languages", () => {
    for (const status of ["pending", "approved", "rejected", "removed"] as const) {
      expect(MESSAGES[statusKey(status)].en).not.toBe("");
    }
    expect(statusKey("removed")).toBe("submissions.status.removed");
    for (const filter of FILTERS) {
      expect(MESSAGES[`submissions.filter.${filter}`].ar).not.toBe("");
    }
    expect(FILTERS).toEqual(["pending", "unseen", "marked", "done"]);
  });

  it("needs a reason of 1 to 300 characters", () => {
    expect(canGiveReason("   ")).toBe(false);
    expect(canGiveReason("Off topic")).toBe(true);
    expect(canGiveReason("x".repeat(300))).toBe(true);
    expect(canGiveReason("x".repeat(301))).toBe(false);
  });

  it("says nothing is here only once a read mark is no longer waiting", () => {
    expect(showsEmpty([], false)).toBe(true);
    expect(showsEmpty([], true)).toBe(false);
    expect(showsEmpty(null, false)).toBe(false);
    expect(showsEmpty([item("a")], false)).toBe(false);
  });

  it("offers the read mark on the unseen tab while there are rows or one is waiting", () => {
    expect(showsMarkSeen("unseen", [item("a")], false)).toBe(true);
    expect(showsMarkSeen("unseen", [], true)).toBe(true);
    expect(showsMarkSeen("unseen", [], false)).toBe(false);
    expect(showsMarkSeen("unseen", null, false)).toBe(false);
    expect(showsMarkSeen("pending", [item("a")], false)).toBe(false);
  });

  it("drops only the items named, keeping the order of the rest", () => {
    const items = [item("a"), item("b"), item("c")];
    expect(withoutItems(items, ["a", "c"]).map(({ id }) => id)).toEqual(["b"]);
    expect(withoutItems(items, []).map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(withoutItems(items, ["zzz"])).toHaveLength(3);
  });
});

const photo = (id: string, photoExpiresAt: string | null): QueueItem => ({
  ...item(id),
  kind: "photo",
  photoExpiresAt,
});

describe("photoRefreshDelay", () => {
  const NOW = Date.parse("2026-11-12T10:00:00Z");

  it("reads the list again 15 s before the soonest link runs out", () => {
    const items = [
      photo("a", "2026-11-12T10:05:00Z"),
      photo("b", "2026-11-12T10:03:00Z"),
      photo("c", null),
    ];
    expect(photoRefreshDelay(items, NOW)).toBe(3 * 60_000 - PHOTO_REFRESH.aheadMs);
  });

  it("waits at least 30 s, so a link already run out cannot make it read in a loop", () => {
    expect(photoRefreshDelay([photo("a", "2026-11-12T09:00:00Z")], NOW)).toBe(
      PHOTO_REFRESH.leastMs,
    );
    expect(photoRefreshDelay([photo("a", "2026-11-12T10:00:40Z")], NOW)).toBe(
      PHOTO_REFRESH.leastMs,
    );
  });

  it("is null with no list, no photo link, or a time it cannot read", () => {
    expect(photoRefreshDelay(null, NOW)).toBeNull();
    expect(photoRefreshDelay([item("a"), photo("c", "soon")], NOW)).toBeNull();
  });
});
