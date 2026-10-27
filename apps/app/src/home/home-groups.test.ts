import { describe, expect, it } from "vitest";
import type { MyEvent } from "#src/event/launch.ts";
import { groupEvents } from "#src/home/home-groups.ts";

const event = (id: string, statusNow: string, extra: Partial<MyEvent> = {}): MyEvent => ({
  id,
  joinCode: id.toUpperCase(),
  name: { ar: null, en: id },
  statusNow,
  status: "active",
  ...extra,
});

const ids = (events: readonly MyEvent[]) => events.map((one) => one.id);

describe("groupEvents", () => {
  it("puts each event in the group of its status now", () => {
    const groups = groupEvents([
      event("a", "live"),
      event("b", "scheduled"),
      event("c", "ended"),
      event("d", "archived"),
      event("e", "draft"),
    ]);
    expect(ids(groups.live)).toEqual(["a"]);
    expect(ids(groups.upcoming).sort()).toEqual(["b", "e"]);
    expect(ids(groups.past).sort()).toEqual(["c", "d"]);
  });

  it("lists upcoming events soonest first and undated ones last", () => {
    const groups = groupEvents([
      event("late", "scheduled", { startsAt: "2026-12-01T10:00:00.000Z" }),
      event("none", "draft", { startsAt: null }),
      event("soon", "scheduled", { startsAt: "2026-11-01T10:00:00.000Z" }),
    ]);
    expect(ids(groups.upcoming)).toEqual(["soon", "late", "none"]);
  });

  it("lists past events newest first by their end, then their start", () => {
    const groups = groupEvents([
      event("old", "ended", { endsAt: "2026-01-02T10:00:00.000Z" }),
      event("new", "archived", { endsAt: "2026-09-02T10:00:00.000Z" }),
      event("start-only", "ended", { startsAt: "2026-05-01T10:00:00.000Z" }),
      event("undated", "ended"),
    ]);
    expect(ids(groups.past)).toEqual(["new", "start-only", "old", "undated"]);
  });

  it("keeps the server's order for equal dates and shows pending and declined requests with their event", () => {
    const groups = groupEvents([
      event("first", "scheduled", { status: "pending" }),
      event("second", "scheduled", { status: "declined" }),
    ]);
    expect(ids(groups.upcoming)).toEqual(["first", "second"]);
  });

  it("returns three empty groups for no events", () => {
    expect(groupEvents([])).toEqual({ live: [], upcoming: [], past: [] });
  });

  it("does not change the list it was given", () => {
    const given = [
      event("b", "scheduled", { startsAt: "2026-12-01T00:00:00Z" }),
      event("a", "scheduled", { startsAt: "2026-11-01T00:00:00Z" }),
    ];
    groupEvents(given);
    expect(ids(given)).toEqual(["b", "a"]);
  });
});
