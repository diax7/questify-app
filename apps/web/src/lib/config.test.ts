import { describe, expect, it } from "vitest";
import { readWebConfig } from "#src/lib/config.ts";

describe("readWebConfig", () => {
  it.each([
    "http://questify-api-staging-3ez01s:3000",
    "http://questify-api",
    "http://127.0.0.1:4100",
    "http://localhost:3000",
  ])("accepts the internal address %s", (apiOrigin) => {
    expect(readWebConfig({ API_ORIGIN: apiOrigin })).toEqual({ apiOrigin });
  });

  it("refuses a missing or empty setting with what to set", () => {
    expect(() => readWebConfig({})).toThrow(/API_ORIGIN is not set.*internal address/);
    expect(() => readWebConfig({ API_ORIGIN: "" })).toThrow(/API_ORIGIN is not set/);
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
    expect(() => readWebConfig({ API_ORIGIN: apiOrigin })).toThrow(
      /must be an internal http address/,
    );
  });

  describe("the store links", () => {
    const base = { API_ORIGIN: "http://questify-api" };

    it("leaves them out when unset or empty", () => {
      expect(readWebConfig({ ...base, APP_STORE_URL: "", PLAY_STORE_URL: undefined })).toEqual({
        apiOrigin: "http://questify-api",
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
});
