import { describe, expect, it } from "vitest";
import type { EventStatus } from "#src/events/store";
import {
  homeWindowOf,
  windowRefusal,
  windowRefusalOf,
  type EventShopRow,
} from "#src/rewards/shop-window";
import { pgError } from "#test/support/fake-pool";

const change = (
  state: "not_open" | "open" | "closed",
  statusNow: EventStatus,
  current: number,
  wanted: number,
) => windowRefusal({ state, statusNow, current, wanted });

describe("windowRefusal (ADR-336)", () => {
  it("lets any value through before the end", () => {
    for (const [state, statusNow] of [
      ["not_open", "draft"],
      ["not_open", "scheduled"],
      ["open", "live"],
    ] as const) {
      expect(change(state, statusNow, 3, 0), statusNow).toBeNull();
      expect(change(state, statusNow, 3, 30), statusNow).toBeNull();
      expect(change(state, statusNow, 3, 2), statusNow).toBeNull();
    }
  });

  it("after the end, while open, takes a longer window and refuses a shorter one", () => {
    expect(change("open", "ended", 3, 4)).toBeNull();
    expect(change("open", "ended", 3, 30)).toBeNull();
    expect(change("open", "ended", 3, 2)).toBe("shorter");
    expect(change("open", "ended", 3, 0)).toBe("shorter");
  });

  it("refuses every change once closed, lengthening included", () => {
    expect(change("closed", "ended", 3, 4)).toBe("closed");
    expect(change("closed", "ended", 3, 30)).toBe("closed");
    expect(change("closed", "ended", 3, 0)).toBe("closed");
    expect(change("closed", "archived", 3, 5)).toBe("closed");
  });

  it("treats sending the stored value as no change in every state", () => {
    expect(change("closed", "ended", 3, 3)).toBeNull();
    expect(change("closed", "archived", 0, 0)).toBeNull();
    expect(change("open", "ended", 5, 5)).toBeNull();
    expect(change("open", "live", 5, 5)).toBeNull();
  });
});

describe("windowRefusalOf (the guard's SW409)", () => {
  it("maps each DETAIL the guard raises to the 409's reason", () => {
    expect(windowRefusalOf(pgError({ code: "SW409", detail: "closed" }))).toBe("closed");
    expect(windowRefusalOf(pgError({ code: "SW409", detail: "shorter" }))).toBe("shorter");
  });

  it("maps nothing else: an unknown DETAIL, another code or a plain error", () => {
    expect(windowRefusalOf(pgError({ code: "SW409", detail: "later" }))).toBeUndefined();
    expect(windowRefusalOf(pgError({ code: "SW409" }))).toBeUndefined();
    expect(windowRefusalOf(pgError({ code: "QE409", detail: "closed" }))).toBeUndefined();
    expect(windowRefusalOf(new Error("closed"))).toBeUndefined();
    expect(windowRefusalOf(null)).toBeUndefined();
    expect(windowRefusalOf("SW409")).toBeUndefined();
  });
});

describe("homeWindowOf (ADR-338)", () => {
  const closes = new Date("2030-01-04T18:00:00Z");
  const row = (fields: Partial<EventShopRow> = {}): EventShopRow => ({
    state: "open",
    closes_at: closes,
    desk_closes: null,
    ...fields,
  });

  it("answers the state and the close as the shop gives them", () => {
    expect(homeWindowOf(row())).toEqual({
      state: "open",
      closesAt: "2030-01-04T18:00:00.000Z",
      deskEndsAt: null,
    });
    expect(homeWindowOf(row({ state: "closed" }))).toMatchObject({ state: "closed" });
    expect(homeWindowOf(row({ state: "not_open", closes_at: null }))).toEqual({
      state: "not_open",
      closesAt: null,
      deskEndsAt: null,
    });
  });

  it("gives the desk's last end only when it comes before the close", () => {
    const early = new Date("2030-01-02T18:00:00Z");
    const earlier = new Date("2030-01-01T18:00:00Z");
    expect(homeWindowOf(row({ desk_closes: [earlier, early] })).deskEndsAt).toBe(
      "2030-01-02T18:00:00.000Z",
    );
    expect(homeWindowOf(row({ desk_closes: [early, earlier] })).deskEndsAt).toBe(
      "2030-01-02T18:00:00.000Z",
    );
    expect(homeWindowOf(row({ desk_closes: [earlier, closes] })).deskEndsAt).toBeNull();
    expect(
      homeWindowOf(row({ desk_closes: [new Date("2030-01-05T00:00:00Z")] })).deskEndsAt,
    ).toBeNull();
    expect(homeWindowOf(row({ desk_closes: [] })).deskEndsAt).toBeNull();
    expect(homeWindowOf(row({ closes_at: null, desk_closes: [early] })).deskEndsAt).toBeNull();
  });

  it("gives the desk's end only while the shop is open, never once closed or before it opens", () => {
    const early = new Date("2030-01-02T18:00:00Z");
    expect(homeWindowOf(row({ state: "closed", desk_closes: [early] })).deskEndsAt).toBeNull();
    expect(homeWindowOf(row({ state: "not_open", desk_closes: [early] })).deskEndsAt).toBeNull();
    expect(homeWindowOf(row({ state: "open", desk_closes: [early] })).deskEndsAt).toBe(
      "2030-01-02T18:00:00.000Z",
    );
  });
});
