import { describe, expect, it } from "vitest";
import { readWebConfig } from "#src/lib/config.ts";

const WEB = { DASHBOARD_ORIGIN: "https://questify.nafes.com" };
const WEB_PARSED = {
  webOrigin: "https://questify.nafes.com",
  consoleOrigin: undefined,
  playerWebSession: false,
};

describe("readWebConfig", () => {
  it.each([
    "http://questify-api-staging-3ez01s:3000",
    "http://questify-api",
    "http://127.0.0.1:4100",
    "http://localhost:3000",
  ])("accepts the internal address %s", (apiOrigin) => {
    expect(readWebConfig({ ...WEB, API_ORIGIN: apiOrigin })).toEqual({ apiOrigin, ...WEB_PARSED });
  });

  it("refuses a missing or empty setting with what to set", () => {
    expect(() => readWebConfig(WEB)).toThrow(/API_ORIGIN is not set.*internal address/);
    expect(() => readWebConfig({ ...WEB, API_ORIGIN: "" })).toThrow(/API_ORIGIN is not set/);
  });

  it.each([
    "https://questify-api-staging-3ez01s.cranl.net",
    "http://questify-api-staging-3ez01s.cranl.net",
    "http://api.questify.sa",
    "https://questify-api:3000",
    "http://questify-api:3000/",
    "http://questify-api:3000/v1",
    "http://user:pass@questify-api:3000",
  ])("refuses %s, which is public or not a bare origin", (apiOrigin) => {
    expect(() => readWebConfig({ ...WEB, API_ORIGIN: apiOrigin })).toThrow(
      /must be an internal http address/,
    );
  });

  describe("the store links", () => {
    const base = { ...WEB, API_ORIGIN: "http://questify-api" };

    it("leaves them out when unset or empty", () => {
      expect(readWebConfig({ ...base, APP_STORE_URL: "", PLAY_STORE_URL: undefined })).toEqual({
        apiOrigin: "http://questify-api",
        ...WEB_PARSED,
      });
    });

    it("keeps https links on each store's own host", () => {
      expect(
        readWebConfig({
          ...base,
          APP_STORE_URL: "https://apps.apple.com/sa/app/questify/id123",
          PLAY_STORE_URL: "https://play.google.com/store/apps/details?id=sa.questify",
        }),
      ).toEqual({
        apiOrigin: "http://questify-api",
        ...WEB_PARSED,
        appStoreUrl: "https://apps.apple.com/sa/app/questify/id123",
        playStoreUrl: "https://play.google.com/store/apps/details?id=sa.questify",
      });
    });

    it.each([
      ["APP_STORE_URL", "http://apps.apple.com/app", /must be an https link on apps.apple.com/],
      ["APP_STORE_URL", "https://play.google.com/x", /must be an https link on apps.apple.com/],
      ["PLAY_STORE_URL", "https://evil.example/store", /must be an https link on play.google.com/],
      ["PLAY_STORE_URL", "not a url", /PLAY_STORE_URL "not a url" is not a URL/],
    ])("refuses %s=%s", (name, value, message) => {
      expect(() => readWebConfig({ ...base, [name]: value })).toThrow(message);
    });
  });

  describe("the web origin (DASHBOARD_ORIGIN) and the player web session switch", () => {
    const base = { API_ORIGIN: "http://questify-api" };

    it("requires the web origin, which the forwarder's Origin rule needs", () => {
      expect(() => readWebConfig(base)).toThrow(/DASHBOARD_ORIGIN is not set/);
      expect(() => readWebConfig({ ...base, DASHBOARD_ORIGIN: "" })).toThrow(
        /DASHBOARD_ORIGIN is not set/,
      );
    });

    it.each(["https://questify.nafes.com", "http://localhost:3100", "http://127.0.0.1:3100"])(
      "accepts %s",
      (origin) => {
        expect(readWebConfig({ ...base, DASHBOARD_ORIGIN: origin }).webOrigin).toBe(origin);
      },
    );

    it.each([
      "http://questify.nafes.com",
      "https://questify.nafes.com/",
      "https://questify.nafes.com/en",
      "questify.nafes.com",
      "not a url",
    ])("refuses %s, which is not an https origin", (origin) => {
      expect(() => readWebConfig({ ...base, DASHBOARD_ORIGIN: origin })).toThrow(
        /DASHBOARD_ORIGIN ".*" must be an https origin/,
      );
    });

    it.each([
      [undefined, false],
      ["", false],
      ["off", false],
      ["on", true],
    ])("reads PLAYER_WEB_SESSION=%s as %s (off by default)", (value, on) => {
      expect(readWebConfig({ ...base, ...WEB, PLAYER_WEB_SESSION: value }).playerWebSession).toBe(
        on,
      );
    });

    it.each(["true", "1", "ON", "yes"])("refuses PLAYER_WEB_SESSION=%s", (value) => {
      expect(() => readWebConfig({ ...base, ...WEB, PLAYER_WEB_SESSION: value })).toThrow(
        /PLAYER_WEB_SESSION ".*" must be "on" or "off"/,
      );
    });
  });

  describe("the console's own host (CONSOLE_ORIGIN, T-810d)", () => {
    const base = { API_ORIGIN: "http://questify-api", ...WEB };

    it.each([undefined, "", " "])("has no console host for %j (everything as before)", (value) => {
      expect(readWebConfig({ ...base, CONSOLE_ORIGIN: value }).consoleOrigin).toBeUndefined();
    });

    it.each(["https://console.questify.nafes.com", "http://console.localhost:3102"])(
      "accepts %s",
      (origin) => {
        expect(readWebConfig({ ...base, CONSOLE_ORIGIN: origin }).consoleOrigin).toBe(origin);
      },
    );

    it.each([
      "http://console.questify.nafes.com",
      "https://console.questify.nafes.com/",
      "https://console.questify.nafes.com/en",
      "console.questify.nafes.com",
    ])("refuses %s, which is not an https origin", (origin) => {
      expect(() => readWebConfig({ ...base, CONSOLE_ORIGIN: origin })).toThrow(
        /CONSOLE_ORIGIN ".*" must be an https origin/,
      );
    });

    it("refuses the dashboard's own origin", () => {
      expect(() => readWebConfig({ ...base, CONSOLE_ORIGIN: WEB.DASHBOARD_ORIGIN })).toThrow(
        /CONSOLE_ORIGIN must be a different host from DASHBOARD_ORIGIN/,
      );
    });
  });
});
