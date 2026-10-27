import { describe, expect, it } from "vitest";
import { nextShopBoundary, readShopWindow, shopClosed, shopLine } from "#src/event/shop-window.ts";

const NOW = Date.parse("2030-01-05T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW + ms).toISOString();

const OPEN = { state: "open", closesAt: at(2 * 24 * HOUR), deskEndsAt: null } as const;

describe("readShopWindow", () => {
  it("reads the window as the API sends it", () => {
    expect(readShopWindow(OPEN)).toEqual(OPEN);
    const closed = { state: "closed", closesAt: at(-HOUR), deskEndsAt: null };
    expect(readShopWindow(closed)).toEqual(closed);
    expect(readShopWindow({ state: "not_open", closesAt: null, deskEndsAt: null })).toEqual({
      state: "not_open",
      closesAt: null,
      deskEndsAt: null,
    });
  });

  it("leaves out what an older API does not send and what this app cannot read", () => {
    expect(readShopWindow(undefined)).toBeNull();
    expect(readShopWindow(null)).toBeNull();
    expect(readShopWindow({ state: "paused", closesAt: null, deskEndsAt: null })).toBeNull();
    expect(readShopWindow({ ...OPEN, closesAt: "tomorrow" })).toBeNull();
    expect(readShopWindow({ state: "open", closesAt: OPEN.closesAt })).toBeNull();
  });
});

describe("shopLine", () => {
  it("says nothing without a window, before the end, and while the shop is not open", () => {
    expect(shopLine(null, true, NOW)).toBeNull();
    expect(shopLine(OPEN, false, NOW)).toBeNull();
    expect(
      shopLine({ state: "not_open", closesAt: OPEN.closesAt, deskEndsAt: null }, true, NOW),
    ).toBeNull();
  });

  it("says when the open shop closes, once the event has ended", () => {
    expect(shopLine(OPEN, true, NOW)).toEqual({
      kind: "open",
      closesAt: OPEN.closesAt,
      desk: null,
    });
  });

  it("says nothing for an open shop without an end", () => {
    expect(shopLine({ ...OPEN, closesAt: null }, true, NOW)).toBeNull();
  });

  it("adds the desk's end while it is ahead, and says the items stopped once it is past", () => {
    const ahead = { ...OPEN, deskEndsAt: at(HOUR) };
    expect(shopLine(ahead, true, NOW)).toEqual({
      kind: "open",
      closesAt: OPEN.closesAt,
      desk: { kind: "until", endsAt: ahead.deskEndsAt },
    });
    const past = { ...OPEN, deskEndsAt: at(-HOUR) };
    expect(shopLine(past, true, NOW)).toEqual({
      kind: "open",
      closesAt: OPEN.closesAt,
      desk: { kind: "stopped" },
    });
  });

  it("treats the desk's end at this very moment as stopped", () => {
    expect(shopLine({ ...OPEN, deskEndsAt: at(0) }, true, NOW)).toMatchObject({
      desk: { kind: "stopped" },
    });
  });

  it("reads a closed shop as closed, with its date when it has one, whatever the event's state", () => {
    const closed = { state: "closed", closesAt: at(-HOUR), deskEndsAt: null } as const;
    expect(shopLine(closed, true, NOW)).toEqual({ kind: "closed", closesAt: closed.closesAt });
    expect(shopLine(closed, false, NOW)).toEqual({ kind: "closed", closesAt: closed.closesAt });
    expect(shopLine({ ...closed, closesAt: null }, true, NOW)).toEqual({
      kind: "closed",
      closesAt: null,
    });
  });
});

describe("shopClosed", () => {
  it("is true only for a closed shop", () => {
    expect(shopClosed({ state: "closed", closesAt: null, deskEndsAt: null })).toBe(true);
    expect(shopClosed(OPEN)).toBe(false);
    expect(shopClosed({ state: "not_open", closesAt: null, deskEndsAt: null })).toBe(false);
    expect(shopClosed(null)).toBe(false);
  });
});

describe("nextShopBoundary", () => {
  it("waits a second past the nearest of the close and the desk's end", () => {
    expect(nextShopBoundary({ ...OPEN, closesAt: at(5 * 60_000) }, NOW)).toBe(5 * 60_000 + 1000);
    expect(nextShopBoundary({ ...OPEN, deskEndsAt: at(90_000) }, NOW)).toBe(91_000);
  });

  it("never waits more than a day", () => {
    expect(nextShopBoundary({ ...OPEN, closesAt: at(40 * 24 * HOUR) }, NOW)).toBe(24 * HOUR);
  });

  it("asks again in 15 seconds when the phone's clock has just passed the close (a phone running ahead)", () => {
    expect(nextShopBoundary({ ...OPEN, closesAt: at(-1) }, NOW)).toBe(15_000);
    expect(nextShopBoundary({ ...OPEN, closesAt: at(0) }, NOW)).toBe(15_000);
    expect(nextShopBoundary({ ...OPEN, closesAt: at(-30_000) }, NOW)).toBe(15_000);
    expect(nextShopBoundary({ ...OPEN, closesAt: at(-119_999) }, NOW)).toBe(15_000);
  });

  it("asks again the same way when the desk's end has just passed", () => {
    expect(nextShopBoundary({ ...OPEN, deskEndsAt: at(-60_000) }, NOW)).toBe(15_000);
  });

  it("takes the nearest delay when one boundary is ahead and another was just passed", () => {
    expect(
      nextShopBoundary({ ...OPEN, closesAt: at(5 * 60_000), deskEndsAt: at(-30_000) }, NOW),
    ).toBe(15_000);
    expect(nextShopBoundary({ ...OPEN, closesAt: at(5_000), deskEndsAt: at(-30_000) }, NOW)).toBe(
      6_000,
    );
  });

  it("ignores a boundary passed long ago, such as a desk that ended days ago while the shop stays open", () => {
    expect(nextShopBoundary({ ...OPEN, closesAt: at(60_000), deskEndsAt: at(-HOUR) }, NOW)).toBe(
      61_000,
    );
    expect(nextShopBoundary({ ...OPEN, deskEndsAt: at(-3 * 24 * HOUR) }, NOW)).toBe(24 * HOUR);
    expect(nextShopBoundary({ ...OPEN, closesAt: at(-120_000) }, NOW)).toBeNull();
    expect(
      nextShopBoundary({ ...OPEN, closesAt: at(-HOUR), deskEndsAt: at(-HOUR) }, NOW),
    ).toBeNull();
  });

  it("returns null when no boundary is set", () => {
    expect(nextShopBoundary({ ...OPEN, closesAt: null }, NOW)).toBeNull();
  });

  it("reads again only while the shop is open", () => {
    expect(nextShopBoundary(null, NOW)).toBeNull();
    expect(
      nextShopBoundary({ state: "closed", closesAt: at(HOUR), deskEndsAt: null }, NOW),
    ).toBeNull();
    expect(
      nextShopBoundary({ state: "not_open", closesAt: at(HOUR), deskEndsAt: null }, NOW),
    ).toBeNull();
  });
});
