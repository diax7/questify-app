import { describe, expect, it } from "vitest";
import { composeConfig } from "#src/config/compose";
import { readPlatformSettings } from "#src/config/read";
import { parseComposedConfig } from "#src/config/validate";
import { REGISTRIES } from "#src/config/registry";
import {
  bannerActive,
  bannerBodySchema,
  eventMaintenanceBodySchema,
  maintenanceBodySchema,
  maintenanceFor,
  readBanner,
  readMaintenance,
} from "./notices";

const EVENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MESSAGE = { ar: "نعود قريبا.", en: "Back soon." };
const OWN = { ar: "الفعالية متوقفة.", en: "This event is paused." };
const BANNER = {
  message: MESSAGE,
  startsAt: "2026-11-05T15:00:00.000Z",
  endsAt: "2026-11-05T18:00:00.000Z",
};

describe("reading the stored maintenance block", () => {
  it("keeps a well-formed global message and event messages", () => {
    expect(readMaintenance({ global: MESSAGE, events: { [EVENT]: OWN } })).toEqual({
      global: MESSAGE,
      events: { [EVENT]: OWN },
    });
  });

  it("drops a half message, a key that is not an event id, and anything that is not an object", () => {
    expect(
      readMaintenance({
        global: { ar: "x", en: " " },
        events: { [EVENT]: { ar: "x" }, "not-an-id": OWN, [OTHER]: OWN },
      }),
    ).toEqual({ events: { [OTHER]: OWN } });
    expect(readMaintenance(null)).toEqual({ events: {} });
    expect(readMaintenance([1])).toEqual({ events: {} });
    expect(readMaintenance({ events: "x" })).toEqual({ events: {} });
  });
});

describe("which message pauses a request", () => {
  const settings = readMaintenance({ global: MESSAGE, events: { [EVENT]: OWN } });

  it("prefers the event's own message, then the platform-wide one", () => {
    expect(maintenanceFor(settings, EVENT)).toEqual(OWN);
    expect(maintenanceFor(settings, OTHER)).toEqual(MESSAGE);
    expect(maintenanceFor(settings, undefined)).toEqual(MESSAGE);
  });

  it("lets another event play when only one event is paused, and the platform level too", () => {
    const only = readMaintenance({ events: { [EVENT]: OWN } });
    expect(maintenanceFor(only, OTHER)).toBeNull();
    expect(maintenanceFor(only, undefined)).toBeNull();
    expect(maintenanceFor(undefined, EVENT)).toBeNull();
  });
});

describe("reading the banner", () => {
  it("keeps a message with a window that ends after it starts, as ISO instants", () => {
    expect(readBanner({ ...BANNER, startsAt: "2026-11-05T18:00:00+03:00" })).toEqual({
      ...BANNER,
      startsAt: "2026-11-05T15:00:00.000Z",
    });
  });

  it("is none for an empty object, a backwards or equal window, a bad date or a half message", () => {
    expect(readBanner({})).toBeUndefined();
    expect(readBanner({ ...BANNER, endsAt: BANNER.startsAt })).toBeUndefined();
    expect(readBanner({ ...BANNER, endsAt: "2026-11-05T14:00:00.000Z" })).toBeUndefined();
    expect(readBanner({ ...BANNER, startsAt: "soon" })).toBeUndefined();
    expect(readBanner({ ...BANNER, message: { ar: "x", en: "" } })).toBeUndefined();
    expect(readBanner(undefined)).toBeUndefined();
  });

  it("is active from its start up to, not including, its end", () => {
    const banner = readBanner(BANNER);
    const start = Date.parse(BANNER.startsAt);
    const end = Date.parse(BANNER.endsAt);
    expect(bannerActive(banner ?? null, start - 1)).toBe(false);
    expect(bannerActive(banner ?? null, start)).toBe(true);
    expect(bannerActive(banner ?? null, end - 1)).toBe(true);
    expect(bannerActive(banner ?? null, end)).toBe(false);
    expect(bannerActive(null, start)).toBe(false);
    expect(bannerActive(undefined, start)).toBe(false);
  });
});

describe("the bodies the console sends", () => {
  it("needs both languages for a pause and a join code for an event", () => {
    expect(maintenanceBodySchema.safeParse({ message: MESSAGE }).success).toBe(true);
    expect(maintenanceBodySchema.safeParse({ message: { ar: "x", en: "" } }).success).toBe(false);
    expect(maintenanceBodySchema.safeParse({ message: MESSAGE, extra: 1 }).success).toBe(false);
    expect(
      eventMaintenanceBodySchema.safeParse({ joinCode: " ABC123 ", message: MESSAGE }).success,
    ).toBe(true);
    expect(
      eventMaintenanceBodySchema.safeParse({ joinCode: "a b", message: MESSAGE }).success,
    ).toBe(false);
  });

  it("refuses a banner that ends when it starts or before, and a date that is not an instant", () => {
    expect(bannerBodySchema.safeParse(BANNER).success).toBe(true);
    expect(bannerBodySchema.safeParse({ ...BANNER, endsAt: BANNER.startsAt }).success).toBe(false);
    expect(bannerBodySchema.safeParse({ ...BANNER, startsAt: "tomorrow" }).success).toBe(false);
  });
});

describe("the composed configuration carries the pause and the banner", () => {
  const platform = readPlatformSettings({
    maintenance: { global: MESSAGE, events: { [EVENT]: OWN } },
    banner: BANNER,
  });

  it("gives the platform document the platform-wide message, and an event its own", () => {
    expect(composeConfig(REGISTRIES, platform, undefined).maintenance).toEqual(MESSAGE);
    expect(composeConfig(REGISTRIES, platform, { id: EVENT }).maintenance).toEqual(OWN);
    expect(composeConfig(REGISTRIES, platform, { id: OTHER }).maintenance).toEqual(MESSAGE);
    expect(composeConfig(REGISTRIES, platform, undefined).banner).toEqual(BANNER);
  });

  it("has neither when nothing is stored", () => {
    const composed = composeConfig(REGISTRIES, readPlatformSettings({}), undefined);
    expect(composed.maintenance).toBeNull();
    expect(composed.banner).toBeNull();
  });

  it("is read by the app, and a copy from before has none and a damaged one shows nothing", () => {
    const composed = {
      ...composeConfig(REGISTRIES, platform, undefined),
      legal: { documents: [] },
    };
    const read = parseComposedConfig(composed);
    expect(read.ok && read.config.maintenance).toEqual(MESSAGE);
    expect(read.ok && read.config.banner).toEqual(BANNER);
    const { maintenance: _m, banner: _b, ...older } = composed;
    const old = parseComposedConfig(older);
    expect(old.ok && [old.config.maintenance, old.config.banner]).toEqual([null, null]);
    const damaged = parseComposedConfig({
      ...composed,
      maintenance: { ar: "x" },
      banner: { ...BANNER, endsAt: "2020-01-01T00:00:00.000Z" },
    });
    expect(damaged.ok && [damaged.config.maintenance, damaged.config.banner]).toEqual([null, null]);
  });
});
