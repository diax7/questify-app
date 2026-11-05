import { describe, expect, it } from "vitest";
import { readWebConfig } from "#src/lib/config.ts";

const HOSTS = {
  DASHBOARD_ORIGIN: "https://questify.nafes.com",
  CONSOLE_ORIGIN: "https://console.questify.nafes.com",
};
const ORIGINS = {
  dashboardOrigin: "https://questify.nafes.com",
  consoleOrigin: "https://console.questify.nafes.com",
};

describe("readWebConfig", () => {
  it.each([
    "http://questify-api-staging-3ez01s:3000",
    "http://questify-api",
    "http://127.0.0.1:4100",
    "http://localhost:3000",
  ])("accepts the internal address %s", (apiOrigin) => {
    expect(readWebConfig({ ...HOSTS, API_ORIGIN: apiOrigin })).toEqual({ apiOrigin, ...ORIGINS });
  });

  it("refuses a missing or empty setting with what to set", () => {
    expect(() => readWebConfig(HOSTS)).toThrow(/API_ORIGIN is not set.*internal address/);
    expect(() => readWebConfig({ ...HOSTS, API_ORIGIN: "" })).toThrow(/API_ORIGIN is not set/);
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
    expect(() => readWebConfig({ ...HOSTS, API_ORIGIN: apiOrigin })).toThrow(
      /must be an internal http address/,
    );
  });

  describe("the store links", () => {
    const base = { ...HOSTS, API_ORIGIN: "http://questify-api" };

    it("leaves them out when unset or empty", () => {
      expect(readWebConfig({ ...base, APP_STORE_URL: "", PLAY_STORE_URL: undefined })).toEqual({
        apiOrigin: "http://questify-api",
        ...ORIGINS,
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
        ...ORIGINS,
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

  describe("the two host origins (T-810d)", () => {
    const base = { ...HOSTS, API_ORIGIN: "http://questify-api" };

    it.each(["DASHBOARD_ORIGIN", "CONSOLE_ORIGIN"])("refuses a missing %s, naming it", (name) => {
      expect(() => readWebConfig({ ...base, [name]: undefined })).toThrow(
        new RegExp(`${name} is not set`),
      );
      expect(() => readWebConfig({ ...base, [name]: "" })).toThrow(
        new RegExp(`${name} is not set`),
      );
    });

    it.each([
      ["CONSOLE_ORIGIN", "console.questify.nafes.com", /is not a URL/],
      ["CONSOLE_ORIGIN", "https://console.questify.nafes.com/", /must be an origin only/],
      ["DASHBOARD_ORIGIN", "https://questify.nafes.com/en", /must be an origin only/],
      ["CONSOLE_ORIGIN", "http://console.questify.nafes.com", /must be https/],
      ["DASHBOARD_ORIGIN", "http://questify.nafes.com", /must be https/],
      ["DASHBOARD_ORIGIN", "http://localhost.evil.example", /must be https/],
    ])("refuses %s=%s", (name, value, message) => {
      expect(() => readWebConfig({ ...base, [name]: value })).toThrow(message);
    });

    it("refuses the same origin for both, naming both settings", () => {
      expect(() => readWebConfig({ ...base, CONSOLE_ORIGIN: HOSTS.DASHBOARD_ORIGIN })).toThrow(
        /CONSOLE_ORIGIN must be a different host from DASHBOARD_ORIGIN/,
      );
    });

    it("accepts http for the local hosts the browser tests use", () => {
      expect(
        readWebConfig({
          API_ORIGIN: "http://127.0.0.1:4100",
          DASHBOARD_ORIGIN: "http://localhost:3100",
          CONSOLE_ORIGIN: "http://console.localhost:3100",
        }),
      ).toEqual({
        apiOrigin: "http://127.0.0.1:4100",
        dashboardOrigin: "http://localhost:3100",
        consoleOrigin: "http://console.localhost:3100",
      });
      expect(
        readWebConfig({ ...base, CONSOLE_ORIGIN: "http://127.0.0.1:3100" }).consoleOrigin,
      ).toBe("http://127.0.0.1:3100");
    });
  });
});
