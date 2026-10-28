import { afterEach, describe, expect, it } from "vitest";
import { getUnread, setUnread } from "#src/push/unread-store.ts";

afterEach(() => setUnread(0));

describe("the bell's unread count", () => {
  it("holds the count the profile and the center give", () => {
    setUnread(4);
    expect(getUnread()).toBe(4);
    setUnread(0);
    expect(getUnread()).toBe(0);
  });

  it("stops at the server's cap and never goes below nothing", () => {
    setUnread(250);
    expect(getUnread()).toBe(100);
    setUnread(-3);
    expect(getUnread()).toBe(0);
  });

  it("keeps whole numbers and reads anything else as none", () => {
    setUnread(3.9);
    expect(getUnread()).toBe(3);
    setUnread(Number.NaN);
    expect(getUnread()).toBe(0);
    setUnread(Number.POSITIVE_INFINITY);
    expect(getUnread()).toBe(0);
  });
});
