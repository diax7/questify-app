import { describe, expect, it } from "vitest";
import {
  isGatedFeature,
  parseComposedConfig,
  validateEventBranding,
  validateEventConfig,
  validatePlatformSettings,
} from "./validate";
import type { Registries } from "./registry";
import { DEFAULT_TERMS } from "./terms";
import { DEFAULT_COMPOSED_LAYOUT } from "#src/layout/layout";

const registries: Registries = {
  features: {
    shop: { gated: false },
    bigScreen: { gated: true },
    usernameChanges: { gated: false, level: "platform" },
  },
  tuning: { qrSeconds: { default: 45, min: 30, max: 60 } },
};
const MESSAGE = { ar: "متوقفة", en: "Paused" };

const platform = (input: unknown) => validatePlatformSettings(registries, input);
const event = (input: unknown) => validateEventConfig(registries, input);

describe("validatePlatformSettings", () => {
  it("accepts an empty object and a full valid one", () => {
    expect(platform({})).toEqual({ ok: true, value: {} });
    const full = {
      features: { shop: { enabled: false, message: MESSAGE, minAppVersion: "1.2.0" } },
      tuning: { qrSeconds: 50 },
    };
    expect(platform(full)).toEqual({ ok: true, value: full });
  });

  it("accepts a platform setting for a feature Questify sets for every event", () => {
    const off = { features: { usernameChanges: { enabled: false } } };
    expect(platform(off)).toEqual({ ok: true, value: off });
  });

  it("refuses a feature the app does not have, naming it (FR-1504)", () => {
    expect(platform({ features: { teleporter: { enabled: true } } })).toEqual({
      ok: false,
      issues: [{ path: "features.teleporter", message: "is not a feature of the app" }],
    });
  });

  it("refuses a tuning number the app does not have", () => {
    expect(platform({ tuning: { warp: 3 } })).toEqual({
      ok: false,
      issues: [{ path: "tuning.warp", message: "is not a tuning number of the app" }],
    });
  });

  it.each([29, 61, -1])(
    "refuses the tuning value %s outside 30 to 60, and says the range",
    (value) => {
      expect(platform({ tuning: { qrSeconds: value } })).toEqual({
        ok: false,
        issues: [{ path: "tuning.qrSeconds", message: "must be a number from 30 to 60" }],
      });
    },
  );

  it("refuses a tuning value that is not a number", () => {
    expect(platform({ tuning: { qrSeconds: Number.NaN } }).ok).toBe(false);
    expect(platform({ tuning: { qrSeconds: "45" } }).ok).toBe(false);
  });

  it("accepts both ends of the tuning range", () => {
    expect(platform({ tuning: { qrSeconds: 30 } }).ok).toBe(true);
    expect(platform({ tuning: { qrSeconds: 60 } }).ok).toBe(true);
  });

  it.each([
    ["a blank Arabic message", { ar: "  ", en: "Paused" }],
    ["a missing English message", { ar: "متوقفة" }],
    ["a message that is a string", "Paused"],
  ])("refuses %s", (_label, message) => {
    const result = platform({ features: { shop: { enabled: false, message } } });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues[0]?.path.startsWith("features.shop.message")).toBe(
      true,
    );
  });

  it.each(["banana", "1", "1.2.3.4", ""])("refuses the minimum app version %j", (minAppVersion) => {
    expect(platform({ features: { shop: { minAppVersion } } })).toEqual({
      ok: false,
      issues: [{ path: "features.shop.minAppVersion", message: "must look like 1.2.3" }],
    });
  });

  it.each(["10.20.30", "1.2", "12.34"])("accepts the minimum app version %s", (minAppVersion) => {
    expect(platform({ features: { shop: { minAppVersion } } }).ok).toBe(true);
  });

  it("says why a blank message is refused", () => {
    expect(platform({ features: { shop: { message: { ar: " ", en: "Paused" } } } })).toEqual({
      ok: false,
      issues: [{ path: "features.shop.message.ar", message: "must not be blank" }],
    });
  });

  it("refuses fields it does not know, so a typo is not silently dropped", () => {
    expect(platform({ features: { shop: { enable: false } } }).ok).toBe(false);
    expect(platform({ banner: {} }).ok).toBe(false);
  });

  it.each([null, "text", 5, []])("refuses %j as a whole", (input) => {
    expect(platform(input).ok).toBe(false);
  });

  it("reports every problem at once", () => {
    const result = platform({ features: { x: {}, y: {} }, tuning: { qrSeconds: 1 } });
    expect(result.ok === false && result.issues.map((issue) => issue.path)).toEqual([
      "features.x",
      "features.y",
      "tuning.qrSeconds",
    ]);
  });
});

describe("validateEventConfig", () => {
  it("accepts an empty object and a valid one", () => {
    expect(event({})).toEqual({ ok: true, value: {} });
    expect(event({ features: { shop: false } })).toEqual({
      ok: true,
      value: { features: { shop: false } },
    });
  });

  it("refuses a switch for a feature the app does not have", () => {
    expect(event({ features: { teleporter: false } })).toEqual({
      ok: false,
      issues: [{ path: "features.teleporter", message: "is not a feature of the app" }],
    });
  });

  it("refuses a switch that is not true or false", () => {
    expect(event({ features: { shop: "off" } }).ok).toBe(false);
  });

  it("refuses an event switch for a feature Questify sets for every event", () => {
    expect(event({ features: { usernameChanges: false } })).toEqual({
      ok: false,
      issues: [{ path: "features.usernameChanges", message: "is set by Questify for every event" }],
    });
  });

  it("refuses an unlock written by the event owner, because only Questify unlocks add-ons", () => {
    expect(event({ unlocked: ["bigScreen"] }).ok).toBe(false);
  });

  it("refuses unknown fields and non-objects", () => {
    expect(event({ theme: "dark" }).ok).toBe(false);
    expect(event(null).ok).toBe(false);
  });
});

describe("isGatedFeature", () => {
  it("is true only for an add-on the app has", () => {
    expect(isGatedFeature(registries, "bigScreen")).toBe(true);
    expect(isGatedFeature(registries, "shop")).toBe(false);
    expect(isGatedFeature(registries, "teleporter")).toBe(false);
  });
});

describe("parseComposedConfig", () => {
  const valid = {
    schemaVersion: 1,
    features: { shop: { enabled: true, minAppVersion: null, message: null } },
    tuning: { qrSeconds: 45 },
    legal: { documents: [{ id: "terms_of_use", version: "0.1" }] },
    terms: DEFAULT_TERMS,
    branding: { accent: null },
    layout: DEFAULT_COMPOSED_LAYOUT,
  };

  it("accepts a composed document", () => {
    expect(parseComposedConfig(valid)).toEqual({ ok: true, config: valid });
    const { legal: _legal, ...withoutLegal } = valid;
    expect(parseComposedConfig(withoutLegal)).toEqual({ ok: false });
  });

  it("reads a copy from before the event's words as the defaults, and drops one bad word", () => {
    const { terms: _terms, ...older } = valid;
    expect(parseComposedConfig(older)).toEqual({ ok: true, config: valid });
    const gems = { ar: { one: "جوهرة", many: "جواهر" }, en: { one: "gem", many: "gems" } };
    const result = parseComposedConfig({
      ...valid,
      terms: { currency: { icon: "gem", ...gems }, player: { ar: "x" }, operator: 7 },
    });
    expect(result).toEqual({
      ok: true,
      config: { ...valid, terms: { ...DEFAULT_TERMS, currency: { icon: "gem", ...gems } } },
    });
  });

  it("reads a copy from before branding as no accent, and an accent it does not know as none", () => {
    const { branding: _branding, ...older } = valid;
    expect(parseComposedConfig(older)).toEqual({ ok: true, config: valid });
    expect(parseComposedConfig({ ...valid, branding: { accent: "neon" } })).toEqual({
      ok: true,
      config: valid,
    });
    expect(parseComposedConfig({ ...valid, branding: { accent: "sky" } })).toEqual({
      ok: true,
      config: { ...valid, branding: { accent: "sky" } },
    });
  });

  it("reads a copy from before layouts as Questify's layout, and one that hides a protected item the same way", () => {
    const { layout: _layout, ...older } = valid;
    expect(parseComposedConfig(older)).toEqual({ ok: true, config: valid });
    const hidesScanner = { bar: ["index", "quests", "rewards", "profile"], home: "x" };
    expect(parseComposedConfig({ ...valid, layout: hidesScanner })).toEqual({
      ok: true,
      config: valid,
    });
    const moved = {
      bar: ["rewards", "index", "scan", "profile"],
      home: DEFAULT_COMPOSED_LAYOUT.home,
    };
    expect(parseComposedConfig({ ...valid, layout: moved })).toEqual({
      ok: true,
      config: { ...valid, layout: moved },
    });
  });

  it("ignores blocks it does not know, so a newer server never breaks an older app", () => {
    const result = parseComposedConfig({ ...valid, banner: { text: "x" } });
    expect(result).toEqual({ ok: true, config: valid });
  });

  it("keeps a feature's message and version as sent", () => {
    const withMessage = {
      ...valid,
      features: { shop: { enabled: false, minAppVersion: "1.2.0", message: MESSAGE } },
    };
    expect(parseComposedConfig(withMessage)).toEqual({ ok: true, config: withMessage });
  });

  it("rejects a message that lacks a language", () => {
    const broken = {
      ...valid,
      features: { shop: { enabled: false, minAppVersion: null, message: { ar: "x" } } },
    };
    expect(parseComposedConfig(broken)).toEqual({ ok: false });
  });

  it("ignores extra fields on a feature", () => {
    const extra = { ...valid, features: { shop: { ...valid.features.shop, theme: "x" } } };
    expect(parseComposedConfig(extra)).toEqual({ ok: true, config: valid });
  });

  it.each([
    ["no schemaVersion", { features: {}, tuning: {} }],
    ["a different schemaVersion", { ...valid, schemaVersion: 2 }],
    [
      "a feature without enabled",
      { ...valid, features: { shop: { minAppVersion: null, message: null } } },
    ],
    ["a non-number tuning value", { ...valid, tuning: { qrSeconds: "45" } }],
    ["null", null],
    ["a string", "config"],
  ])("rejects %s, so the app keeps its last working copy", (_label, input) => {
    expect(parseComposedConfig(input)).toEqual({ ok: false });
  });
});

describe("validateEventBranding", () => {
  it("accepts an accent from the curated list, or null for the brand colour", () => {
    expect(validateEventBranding({ accent: "violet" })).toEqual({
      ok: true,
      value: { accent: "violet" },
    });
    expect(validateEventBranding({ accent: null })).toEqual({ ok: true, value: { accent: null } });
  });

  it.each([
    ["a free colour", { accent: "#FF0000" }],
    ["an unknown name", { accent: "neon" }],
    ["no accent", {}],
    ["a font", { accent: "sky", font: "Comic Sans" }],
    ["a theme", { accent: "sky", theme: "dark" }],
    ["a string", "sky"],
    ["null", null],
  ])("refuses %s, so no free colour, font or theme exists (FR-1023)", (_label, input) => {
    expect(validateEventBranding(input).ok).toBe(false);
  });
});
