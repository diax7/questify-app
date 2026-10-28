import type { NotificationItem } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  appendRows,
  joinRouteOf,
  mergeFirstPage,
  rowRoute,
  stampOf,
  withRead,
  type CenterList,
} from "#src/push/center.ts";

const EVENT = "5f0f2b0e-8c3e-4d7c-9a51-2a2f0b1c3d4e";

const row = (id: number, over: Partial<NotificationItem> = {}): NotificationItem => ({
  id,
  kind: "flash_quest",
  topic: "announcements",
  eventId: EVENT,
  refs: {},
  title: "Winter Fest",
  body: "Flash quest",
  createdAt: "2026-10-28T13:05:00.000Z",
  read: false,
  optOut: false,
  joinCode: null,
  ...over,
});

describe("appendRows", () => {
  it("adds the next page after the rows shown", () => {
    expect(appendRows([row(9), row(8)], [row(7), row(6)]).map((r) => r.id)).toEqual([9, 8, 7, 6]);
  });

  it("does not show a row twice when the list moved between two pages", () => {
    expect(appendRows([row(9), row(8)], [row(8), row(7)]).map((r) => r.id)).toEqual([9, 8, 7]);
    expect(appendRows([], [row(2), row(1)]).map((r) => r.id)).toEqual([2, 1]);
    expect(appendRows([row(2)], [])).toHaveLength(1);
  });
});

const ids = (list: CenterList) => list.rows?.map((r) => r.id);
const page = (items: number[], nextBefore: number | null) => ({
  items: items.map((id) => row(id)),
  nextBefore,
  unread: 0,
});

describe("mergeFirstPage", () => {
  it("is the whole list when nothing was read before", () => {
    const merged = mergeFirstPage({ rows: null, next: null }, page([5, 4], 4));
    expect([ids(merged), merged.next]).toEqual([[5, 4], 4]);
  });

  it("keeps the older pages already loaded and the cursor below them", () => {
    const loaded: CenterList = { rows: [4, 3, 2, 1].map((id) => row(id)), next: 1 };
    const merged = mergeFirstPage(loaded, page([6, 5, 4], 4));
    expect(ids(merged)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(merged.next).toBe(1);
  });

  it("is the same list when nothing new arrived", () => {
    const loaded: CenterList = { rows: [6, 5, 4, 3, 2, 1].map((id) => row(id)), next: 1 };
    const merged = mergeFirstPage(loaded, page([6, 5, 4], 4));
    expect([ids(merged), merged.next]).toEqual([[6, 5, 4, 3, 2, 1], 1]);
  });

  it("drops the older pages when more than a page arrived, as rows between could be missing", () => {
    const loaded: CenterList = { rows: [4, 3, 2, 1].map((id) => row(id)), next: 1 };
    const merged = mergeFirstPage(loaded, page([9, 8, 7], 7));
    expect([ids(merged), merged.next]).toEqual([[9, 8, 7], 7]);
    const adjacent = mergeFirstPage(loaded, page([6, 5], 5));
    expect([ids(adjacent), adjacent.next]).toEqual([[6, 5], 5]);
  });

  it("replaces a row the new first page also holds", () => {
    const loaded: CenterList = { rows: [4, 3, 2].map((id) => row(id, { read: false })), next: 2 };
    const fresh = { items: [row(5), row(4, { read: true })], nextBefore: 4, unread: 1 };
    const merged = mergeFirstPage(loaded, fresh);
    expect(ids(merged)).toEqual([5, 4, 3, 2]);
    expect(merged.rows?.[1]?.read).toBe(true);
  });

  it("takes the first page's own cursor when it reaches back past everything held", () => {
    const loaded: CenterList = { rows: [3, 2].map((id) => row(id)), next: 2 };
    const deep = mergeFirstPage(loaded, page([4, 3, 2], 2));
    expect([ids(deep), deep.next]).toEqual([[4, 3, 2], 2]);
  });

  it("is the first page alone when it is the last page too, or empty", () => {
    const loaded: CenterList = { rows: [3, 2, 1].map((id) => row(id)), next: 1 };
    expect(mergeFirstPage(loaded, page([3], null))).toMatchObject({ next: null });
    expect(ids(mergeFirstPage(loaded, page([3], null)))).toEqual([3]);
    expect(ids(mergeFirstPage(loaded, page([], null)))).toEqual([]);
  });
});

describe("withRead", () => {
  const rows = [row(3), row(2), row(1, { read: true })];

  it("shows the named rows as read and leaves the others", () => {
    expect(withRead(rows, [2]).map((r) => [r.id, r.read])).toEqual([
      [3, false],
      [2, true],
      [1, true],
    ]);
  });

  it("shows every row as read for all", () => {
    expect(withRead(rows, null).every((r) => r.read)).toBe(true);
  });

  it("changes nothing for an id it does not hold, and never edits the rows it was given", () => {
    expect(withRead(rows, [99]).map((r) => r.read)).toEqual([false, false, true]);
    expect(rows.map((r) => r.read)).toEqual([false, false, true]);
  });
});

describe("rowRoute", () => {
  it("opens the screen the kind names, using the row's event and reference ids", () => {
    const quest = "0b9a7d3c-1f2e-4a5b-8c6d-7e8f9a0b1c2d";
    expect(rowRoute(row(1, { refs: { quest } }))).toEqual({
      kind: "route",
      href: `/event/${EVENT}/quests?quest=${quest}`,
    });
  });

  it("opens an invitation's event on the join screen by its code, joined by link; no other row", () => {
    expect(joinRouteOf(row(1, { kind: "invitation", optOut: true, joinCode: "WINTER26" }))).toEqual(
      {
        pathname: "/join/[code]",
        params: { code: "WINTER26", via: "link" },
      },
    );
    expect(joinRouteOf(row(1))).toBeNull();
  });

  it("stays in the center for a promotion and for a kind it does not know", () => {
    expect(rowRoute(row(1, { kind: "invitation", optOut: true }))).toEqual({ kind: "center" });
    expect(rowRoute(row(1, { kind: "from_a_newer_app" }))).toEqual({ kind: "center" });
    expect(rowRoute(row(1, { eventId: null }))).toEqual({ kind: "center" });
  });
});

describe("stampOf", () => {
  it("writes the day, month and 24-hour time with Western digits in both languages", () => {
    expect(stampOf("2026-10-28T13:05:00.000Z", "en", "UTC")).toBe("28 Oct, 13:05");
    const arabic = stampOf("2026-10-28T13:05:00.000Z", "ar", "UTC");
    expect(arabic).toMatch(/^28 .+ 13:05$/u);
    expect(arabic).not.toMatch(/[٠-٩]/u);
  });

  it("uses the time zone it is given", () => {
    expect(stampOf("2026-10-28T23:30:00.000Z", "en", "Asia/Riyadh")).toBe("29 Oct, 02:30");
  });

  it("is empty for a time it cannot read, never 'Invalid Date'", () => {
    expect(stampOf("", "en")).toBe("");
    expect(stampOf("yesterday", "ar")).toBe("");
  });
});
