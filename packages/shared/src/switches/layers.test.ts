import { describe, expect, it } from "vitest";
import { composeConfig } from "#src/config/compose";
import { FEATURES, REGISTRIES, type Registries } from "#src/config/registry";
import {
  eventLayersOf,
  eventLayersSchema,
  featureLayer,
  isOrganizerOverridable,
  organizerFeaturesView,
  organizerFeaturesViewSchema,
  organizerOverrideBodySchema,
  ownerMaySwitchOn,
  platformForOrganizer,
} from "./layers";

const registries: Registries = {
  features: {
    shop: { gated: false },
    ratings: { gated: false, eventOffByDefault: true },
    streak: { gated: false, level: "platform" },
    screen: { gated: true },
    beta: { gated: false, offByDefault: true },
  },
  tuning: {},
};
const message = { ar: "متوقفة", en: "Paused" };

describe("isOrganizerOverridable", () => {
  it("is true for every event-level feature, false for a Questify-wide one", () => {
    expect(isOrganizerOverridable({ gated: false })).toBe(true);
    expect(isOrganizerOverridable({ gated: true })).toBe(true);
    expect(isOrganizerOverridable({ gated: false, level: "platform" })).toBe(false);
  });

  it("names exactly the sixteen event-level features (T-711b)", () => {
    const keys = Object.entries(FEATURES)
      .filter(([, definition]) => isOrganizerOverridable(definition))
      .map(([key]) => key)
      .sort();
    expect(keys).toEqual([
      "agenda",
      "bigScreen",
      "boosts",
      "cheers",
      "community",
      "flashQuests",
      "helpDesk",
      "maps",
      "meetSomeone",
      "miniGames",
      "polls",
      "questRatings",
      "ranking",
      "rankingToday",
      "shareQuests",
      "shop",
    ]);
  });
});

describe("platformForOrganizer", () => {
  it("returns the platform itself when there is no override", () => {
    const platform = { features: { shop: { enabled: false } } };
    expect(platformForOrganizer(registries, platform, {})).toBe(platform);
  });

  it("lets an override On win over the platform's Off and drops the platform's message", () => {
    const platform = { features: { shop: { enabled: false, message, minAppVersion: "1.2" } } };
    expect(platformForOrganizer(registries, platform, { shop: true }).features?.["shop"]).toEqual({
      enabled: true,
      minAppVersion: "1.2",
    });
  });

  it("lets an override Off win over the platform's On", () => {
    expect(platformForOrganizer(registries, {}, { shop: false }).features?.["shop"]).toEqual({
      enabled: false,
    });
  });

  it("ignores a key the app does not have and a feature that cannot be overridden", () => {
    const platform = { features: { streak: { enabled: false } } };
    const result = platformForOrganizer(registries, platform, { gone: true, streak: true });
    expect(result.features).toEqual(platform.features);
  });

  it("changes what the composed configuration says for that organizer's events only", () => {
    const platform = { features: { shop: { enabled: false, message } } };
    const mine = composeConfig(
      registries,
      platformForOrganizer(registries, platform, { shop: true }),
      {},
    );
    const others = composeConfig(registries, platform, {});
    expect(mine.features["shop"]).toMatchObject({ enabled: true, message: null });
    expect(others.features["shop"]).toMatchObject({ enabled: false, message });
    const off = composeConfig(
      registries,
      platformForOrganizer(registries, {}, { shop: false }),
      {},
    );
    expect(off.features["shop"]).toMatchObject({ enabled: false, message: null });
  });
});

const shop = (platform: object, event: object) => featureLayer(registries, platform, event, "shop");

describe("featureLayer", () => {
  it("hides what the platform turns off, and what has no event layer or does not exist", () => {
    expect(shop({ features: { shop: { enabled: false } } }, {})).toBe("hidden");
    expect(featureLayer(registries, {}, {}, "streak")).toBe("hidden");
    expect(featureLayer(registries, {}, {}, "gone")).toBe("hidden");
    expect(featureLayer(registries, {}, {}, "beta")).toBe("hidden");
    expect(featureLayer(registries, { features: { beta: { enabled: true } } }, {}, "beta")).toBe(
      "on",
    );
  });

  it("is on unless the owner turned it off, and off by default for a feature that starts off", () => {
    expect(shop({}, {})).toBe("on");
    expect(shop({}, { features: { shop: false } })).toBe("off");
    expect(featureLayer(registries, {}, {}, "ratings")).toBe("off");
    expect(featureLayer(registries, {}, { features: { ratings: true } }, "ratings")).toBe("on");
  });

  it("locks an add-on until Questify unlocks it for the event", () => {
    expect(featureLayer(registries, {}, {}, "screen")).toBe("locked");
    expect(featureLayer(registries, {}, { unlocked: ["screen"] }, "screen")).toBe("on");
    expect(
      featureLayer(
        registries,
        { features: { screen: { enabled: false } } },
        { unlocked: ["screen"] },
        "screen",
      ),
    ).toBe("hidden");
  });

  it("agrees with the composed configuration about what is on", () => {
    for (const platform of [{}, { features: { shop: { enabled: false } } }]) {
      for (const event of [{}, { features: { shop: false } }, { unlocked: ["screen"] }]) {
        const composed = composeConfig(registries, platform, event);
        for (const key of ["shop", "screen", "ratings"]) {
          const layer = featureLayer(registries, platform, event, key);
          expect(layer === "on", `${key} ${JSON.stringify([platform, event])}`).toBe(
            composed.features[key]?.enabled,
          );
        }
      }
    }
  });
});

describe("ownerMaySwitchOn", () => {
  it("is true for a switch that is on or off, false for a hidden or a locked feature", () => {
    expect(
      ["on", "off", "hidden", "locked"].map((layer) => ownerMaySwitchOn(layer as never)),
    ).toEqual([true, true, false, false]);
  });
});

describe("eventLayersOf", () => {
  it("lists what the owner can see, sorted, with hidden features left out", () => {
    const layers = eventLayersOf(
      registries,
      { features: { shop: { enabled: false } } },
      { features: { ratings: true } },
    );
    expect(eventLayersSchema.parse(layers)).toEqual(layers);
    expect(layers.features).toEqual([
      { key: "ratings", state: "on", addOn: false, request: null },
      { key: "screen", state: "locked", addOn: true, request: null },
    ]);
  });

  it("gives an add-on its latest request and a switch none, whatever the map holds", () => {
    const asked = { status: "open", at: "2026-11-03T08:00:00.000Z" } as const;
    const layers = eventLayersOf(registries, {}, {}, { screen: asked, shop: asked });
    expect(eventLayersSchema.parse(layers)).toEqual(layers);
    const byKey = Object.fromEntries(layers.features.map((row) => [row.key, row.request]));
    expect(byKey).toMatchObject({ screen: asked, shop: null, ratings: null });
    expect(
      eventLayersSchema.safeParse({
        features: [
          { key: "screen", state: "locked", addOn: true, request: { status: "gone", at: "x" } },
        ],
      }).success,
    ).toBe(false);
  });

  it("lists the real registry's event-level features and none of the platform ones", () => {
    const keys = eventLayersOf(REGISTRIES, {}, {}).features.map((row) => row.key);
    expect(keys).toContain("shop");
    expect(keys).toContain("bigScreen");
    expect(keys).not.toContain("dailyStreak");
    expect(keys).not.toContain("locationQuests");
  });
});

describe("organizerFeaturesView", () => {
  it("lists the overridable features with the platform's switch, the override and the result", () => {
    const view = organizerFeaturesView(
      registries,
      { features: { shop: { enabled: false } } },
      { shop: true, beta: false, gone: true },
    );
    expect(organizerFeaturesViewSchema.parse(view)).toEqual(view);
    expect(view.features).toEqual([
      { key: "beta", platformEnabled: false, override: false, effective: false },
      { key: "ratings", platformEnabled: true, override: null, effective: true },
      { key: "screen", platformEnabled: true, override: null, effective: true },
      { key: "shop", platformEnabled: false, override: true, effective: true },
    ]);
  });
});

describe("organizerOverrideBodySchema", () => {
  it("takes a boolean and nothing else", () => {
    expect(organizerOverrideBodySchema.safeParse({ enabled: true }).success).toBe(true);
    expect(organizerOverrideBodySchema.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(organizerOverrideBodySchema.safeParse({ enabled: true, message: null }).success).toBe(
      false,
    );
    expect(organizerOverrideBodySchema.safeParse({}).success).toBe(false);
  });
});
