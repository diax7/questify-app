import { describe, expect, it } from "vitest";
import {
  checkBanner,
  checkEventPause,
  checkGlobalPause,
  eventResumePath,
  instantOf,
  localInputOf,
  readNotices,
} from "#src/lib/console-notices.ts";

const FULL = { ar: "نعود قريبا.", en: "Back soon." };

describe("the pause forms", () => {
  it("needs both languages, trimmed", () => {
    expect(checkGlobalPause({ ar: " نعود ", en: " Back " })).toEqual({
      ok: true,
      body: { message: { ar: "نعود", en: "Back" } },
    });
    const half = checkGlobalPause({ ar: "", en: "Back" });
    expect(half.ok ? [] : [...half.fields]).toEqual(["message.ar"]);
    expect(checkGlobalPause({ ar: "", en: "" }).ok).toBe(false);
  });

  it("names the join code when it is not one", () => {
    expect(checkEventPause("ABC123", FULL).ok).toBe(true);
    const bad = checkEventPause("a b", FULL);
    expect(bad.ok ? [] : [...bad.fields]).toEqual(["joinCode"]);
  });

  it("builds the resume path from the event id", () => {
    expect(eventResumePath("0f0")).toBe("/v1/admin/switches/maintenance/events/0f0");
  });
});

describe("the banner form", () => {
  it("turns local times into instants and checks the window", () => {
    const checked = checkBanner({
      message: FULL,
      startsAt: "2026-11-05T18:00",
      endsAt: "2026-11-05T21:30",
    });
    expect(checked.ok && Date.parse(checked.body.endsAt) - Date.parse(checked.body.startsAt)).toBe(
      3.5 * 3_600_000,
    );
  });

  it("refuses a window that ends first, a blank time and a half message", () => {
    const backwards = checkBanner({
      message: FULL,
      startsAt: "2026-11-05T21:00",
      endsAt: "2026-11-05T18:00",
    });
    expect(backwards.ok ? [] : [...backwards.fields]).toEqual(["endsAt"]);
    expect(checkBanner({ message: FULL, startsAt: "", endsAt: "" }).ok).toBe(false);
    expect(
      checkBanner({
        message: { ar: "x", en: "" },
        startsAt: "2026-11-05T18:00",
        endsAt: "2026-11-05T19:00",
      }).ok,
    ).toBe(false);
  });

  it("round-trips an instant through the box in Western digits", () => {
    const iso = "2026-11-05T15:00:00.000Z";
    expect(localInputOf(iso)).toMatch(/^2026-11-0[56]T\d{2}:\d{2}$/);
    expect(instantOf(localInputOf(iso))).toBe(iso);
    expect(instantOf("")).toBeUndefined();
    expect(instantOf("2026-13-45T99:99")).toBeUndefined();
  });
});

describe("reading the tab", () => {
  it("accepts the API's shape and refuses another", () => {
    const view = { maintenance: { global: null, events: [] }, banner: null };
    expect(readNotices(view)).toEqual(view);
    expect(readNotices({ maintenance: null })).toBeUndefined();
  });
});
