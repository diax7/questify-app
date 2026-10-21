import { describe, expect, it } from "vitest";
import { composeConfig } from "./compose";
import type { FeatureRegistry, TuningRegistry } from "./registry";

const FEATURES: FeatureRegistry = {
  shop: { gated: false },
  cheers: { gated: false },
  bigScreen: { gated: true },
};
const TUNING: TuningRegistry = {
  qrSeconds: { default: 45, min: 30, max: 60 },
  graceSeconds: { default: 5, min: 0, max: 30 },
};
const registries = { features: FEATURES, tuning: TUNING };

const OFF_MESSAGE = { ar: "الميزة متوقفة مؤقتا.", en: "This feature is paused." };

describe("composeConfig defaults", () => {
  it("turns every ungated feature on and every gated one off, and uses the default tuning", () => {
    expect(composeConfig(registries, {}, undefined)).toEqual({
      schemaVersion: 1,
      features: {
        bigScreen: { enabled: false, minAppVersion: null, message: null },
        cheers: { enabled: true, minAppVersion: null, message: null },
        shop: { enabled: true, minAppVersion: null, message: null },
      },
      tuning: { graceSeconds: 5, qrSeconds: 45 },
      legal: {
        documents: [
          { id: "terms_of_use", version: "0.1" },
          { id: "privacy_policy", version: "0.1" },
          { id: "community_guidelines", version: "0.1" },
        ],
      },
    });
  });

  it("ignores an event switch for a platform-level feature; only the platform turns it off", () => {
    const withRenames = {
      features: { ...FEATURES, renames: { gated: false, level: "platform" as const } },
      tuning: TUNING,
    };
    const stored = { features: { renames: false } };
    expect(composeConfig(withRenames, {}, stored).features["renames"]?.enabled).toBe(true);
    expect(
      composeConfig(withRenames, { features: { renames: { enabled: false } } }, undefined).features[
        "renames"
      ]?.enabled,
    ).toBe(false);
  });

  it("lists features and tuning in a fixed order, so equal settings always give equal documents", () => {
    const a = composeConfig(registries, {}, undefined);
    const reversed: FeatureRegistry = {
      bigScreen: { gated: true },
      cheers: { gated: false },
      shop: { gated: false },
    };
    const b = composeConfig({ features: reversed, tuning: TUNING }, {}, undefined);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a.features)).toEqual(["bigScreen", "cheers", "shop"]);
  });
});

describe("platform settings", () => {
  it("switches a feature off for everyone and shows its message", () => {
    const config = composeConfig(
      registries,
      { features: { shop: { enabled: false, message: OFF_MESSAGE } } },
      undefined,
    );
    expect(config.features["shop"]).toEqual({
      enabled: false,
      minAppVersion: null,
      message: OFF_MESSAGE,
    });
  });

  it("shows no message for a feature that is on, even if one is stored", () => {
    const config = composeConfig(
      registries,
      { features: { shop: { enabled: true, message: OFF_MESSAGE } } },
      undefined,
    );
    expect(config.features["shop"]?.message).toBeNull();
  });

  it("carries the minimum app version of a feature", () => {
    const config = composeConfig(
      registries,
      { features: { cheers: { minAppVersion: "1.4.0" } } },
      undefined,
    );
    expect(config.features["cheers"]).toEqual({
      enabled: true,
      minAppVersion: "1.4.0",
      message: null,
    });
  });

  it("ignores settings for features the app does not have (it can only switch on what it ships)", () => {
    const config = composeConfig(
      registries,
      { features: { teleporter: { enabled: true } } },
      undefined,
    );
    expect(Object.keys(config.features)).toEqual(["bigScreen", "cheers", "shop"]);
  });

  it("uses a tuning number inside its range and falls back to the default outside it", () => {
    const inside = composeConfig(registries, { tuning: { qrSeconds: 50 } }, undefined);
    expect(inside.tuning["qrSeconds"]).toBe(50);
    for (const bad of [29, 61, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        composeConfig(registries, { tuning: { qrSeconds: bad } }, undefined).tuning["qrSeconds"],
      ).toBe(45);
    }
  });

  it("treats a number below the range or minus infinity as unusable", () => {
    for (const bad of [Number.NEGATIVE_INFINITY, -5, 0]) {
      expect(
        composeConfig(registries, { tuning: { qrSeconds: bad } }, undefined).tuning["qrSeconds"],
      ).toBe(45);
    }
  });

  it("gives no message for a feature that is off without one", () => {
    const config = composeConfig(registries, { features: { shop: { enabled: false } } }, undefined);
    expect(config.features["shop"]).toEqual({ enabled: false, minAppVersion: null, message: null });
  });

  it("accepts the ends of a tuning range", () => {
    expect(
      composeConfig(registries, { tuning: { qrSeconds: 30 } }, undefined).tuning["qrSeconds"],
    ).toBe(30);
    expect(
      composeConfig(registries, { tuning: { qrSeconds: 60 } }, undefined).tuning["qrSeconds"],
    ).toBe(60);
  });

  it("ignores tuning for numbers the app does not have", () => {
    expect(
      Object.keys(composeConfig(registries, { tuning: { warp: 9 } }, undefined).tuning),
    ).toEqual(["graceSeconds", "qrSeconds"]);
  });
});

describe("event configuration", () => {
  it("lets an event switch a feature off for itself only", () => {
    const off = composeConfig(registries, {}, { features: { cheers: false } });
    expect(off.features["cheers"]?.enabled).toBe(false);
    expect(composeConfig(registries, {}, undefined).features["cheers"]?.enabled).toBe(true);
  });

  it("never lets an event switch on what the platform switched off", () => {
    const config = composeConfig(
      registries,
      { features: { shop: { enabled: false } } },
      { features: { shop: true } },
    );
    expect(config.features["shop"]?.enabled).toBe(false);
  });

  it("hides a gated feature until the event has it unlocked", () => {
    expect(composeConfig(registries, {}, {}).features["bigScreen"]?.enabled).toBe(false);
    expect(
      composeConfig(registries, {}, { unlocked: ["bigScreen"] }).features["bigScreen"]?.enabled,
    ).toBe(true);
  });

  it("does not let an unlock switch on a feature the platform switched off", () => {
    const config = composeConfig(
      registries,
      { features: { bigScreen: { enabled: false } } },
      { unlocked: ["bigScreen"] },
    );
    expect(config.features["bigScreen"]?.enabled).toBe(false);
  });

  it("lets an event also switch off a gated feature it has unlocked", () => {
    const config = composeConfig(
      registries,
      {},
      { unlocked: ["bigScreen"], features: { bigScreen: false } },
    );
    expect(config.features["bigScreen"]?.enabled).toBe(false);
  });

  it("ignores unlock entries for features that are not gated or not shipped", () => {
    const config = composeConfig(
      registries,
      { features: { shop: { enabled: false } } },
      { unlocked: ["shop", "teleporter"] },
    );
    expect(config.features["shop"]?.enabled).toBe(false);
    expect(config.features).not.toHaveProperty("teleporter");
  });

  it("keeps the platform's message and version for a feature an event switched off", () => {
    const config = composeConfig(
      registries,
      { features: { cheers: { minAppVersion: "1.2.0", message: OFF_MESSAGE } } },
      { features: { cheers: false } },
    );
    expect(config.features["cheers"]).toEqual({
      enabled: false,
      minAppVersion: "1.2.0",
      message: null,
    });
  });
});
