import type { ComposedConfig } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { bannerMessage, maintenanceMessage } from "#src/config/notices.ts";

const message = (ar: string, en: string) => ({ ar, en });
const config = (extra: Record<string, unknown>) =>
  ({ schemaVersion: 1, features: {}, tuning: {}, ...extra }) as unknown as ComposedConfig;
const WINDOW = {
  startsAt: "2026-11-05T15:00:00.000Z",
  endsAt: "2026-11-05T18:00:00.000Z",
};

describe("why play is paused (T-703b)", () => {
  it("is the message in the player's language, and null while play runs", () => {
    const paused = config({ maintenance: message("نعود قريبا.", "Back soon.") });
    expect(maintenanceMessage(paused, "en")).toBe("Back soon.");
    expect(maintenanceMessage(paused, "ar")).toBe("نعود قريبا.");
    expect(maintenanceMessage(config({ maintenance: null }), "en")).toBeNull();
    expect(maintenanceMessage(null, "en")).toBeNull();
    expect(maintenanceMessage(undefined, "ar")).toBeNull();
    expect(maintenanceMessage(config({ maintenance: message(" ", " ") }), "en")).toBeNull();
  });

  it("is null for a copy kept before maintenance existed", () => {
    expect(maintenanceMessage(config({}), "en")).toBeNull();
  });
});

describe("the scheduled banner (T-703b)", () => {
  const scheduled = config({
    banner: { message: message("مهرجان الليلة", "Tonight"), ...WINDOW },
  });
  const start = Date.parse(WINDOW.startsAt);
  const end = Date.parse(WINDOW.endsAt);

  it("shows from its start and is gone from its end, by the phone's clock", () => {
    expect(bannerMessage(scheduled, "en", start - 1)).toBeNull();
    expect(bannerMessage(scheduled, "en", start)).toBe("Tonight");
    expect(bannerMessage(scheduled, "ar", end - 1)).toBe("مهرجان الليلة");
    expect(bannerMessage(scheduled, "en", end)).toBeNull();
  });

  it("says nothing without a banner or a configuration", () => {
    expect(bannerMessage(config({ banner: null }), "en", start)).toBeNull();
    expect(bannerMessage(config({}), "en", start)).toBeNull();
    expect(bannerMessage(undefined, "en", start)).toBeNull();
  });
});
