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
});
