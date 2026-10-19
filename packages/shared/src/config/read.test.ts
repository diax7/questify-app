import { describe, expect, it } from "vitest";
import { readEventSwitches, readPlatformSettings } from "./read";

const MESSAGE = { ar: "متوقفة", en: "Paused" };

describe("readPlatformSettings", () => {
  it("keeps well-formed settings as they are", () => {
    const stored = {
      features: { shop: { enabled: false, message: MESSAGE, minAppVersion: "1.2.0" } },
      tuning: { qrSeconds: 50 },
    };
    expect(readPlatformSettings(stored)).toStrictEqual(stored);
  });

  it.each(["10.20.30", "1.2", "12.34"])("accepts the version %s", (minAppVersion) => {
    expect(readPlatformSettings({ features: { shop: { minAppVersion } } })).toStrictEqual({
      features: { shop: { minAppVersion } },
    });
  });

  it("keeps only the block that is present", () => {
    expect(readPlatformSettings({ tuning: { a: 1 } })).toStrictEqual({ tuning: { a: 1 } });
    expect(readPlatformSettings({ features: {} })).toStrictEqual({ features: {} });
  });

  it("keeps a message that has both languages", () => {
    expect(readPlatformSettings({ features: { shop: { message: MESSAGE } } })).toStrictEqual({
      features: { shop: { message: MESSAGE } },
    });
  });

  it("returns nothing for nothing", () => {
    expect(readPlatformSettings({})).toStrictEqual({});
  });

  it("drops a damaged value and keeps the rest", () => {
    const result = readPlatformSettings({
      features: {
        shop: { enabled: "yes", message: { ar: "x" }, minAppVersion: "soon" },
        cheers: { enabled: false },
        polls: 5,
        bigScreen: null,
      },
      tuning: { good: 3, bad: "3", worse: null },
    });
    expect(result).toStrictEqual({
      features: { shop: {}, cheers: { enabled: false }, polls: {}, bigScreen: {} },
      tuning: { good: 3 },
    });
  });

  it("ignores blank messages and versions with four parts", () => {
    const result = readPlatformSettings({
      features: { shop: { message: { ar: " ", en: "ok" }, minAppVersion: "1.2.3.4" } },
    });
    expect(result).toStrictEqual({ features: { shop: {} } });
  });

  it.each([null, "text", 5, [], true])("ignores %j where an object is expected", (junk) => {
    expect(readPlatformSettings({ features: junk, tuning: junk })).toStrictEqual({});
  });
});

describe("readEventSwitches", () => {
  it("keeps true and false and drops everything else", () => {
    expect(
      readEventSwitches({ features: { a: true, b: false, c: "off", d: 1, e: null } }),
    ).toStrictEqual({
      a: true,
      b: false,
    });
  });

  it.each([
    null,
    undefined,
    "text",
    5,
    [],
    {},
    { features: null },
    { features: [] },
    { features: "x" },
  ])("returns no switches for %j", (junk) => {
    expect(readEventSwitches(junk)).toStrictEqual({});
  });

  it("ignores other keys of the event config", () => {
    expect(
      readEventSwitches({ branding: { accent: "gold" }, features: { a: false } }),
    ).toStrictEqual({
      a: false,
    });
  });
});
