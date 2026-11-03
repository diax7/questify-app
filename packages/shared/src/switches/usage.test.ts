import { describe, expect, it } from "vitest";
import { REGISTRIES, type EventConfig, type Registries } from "#src/config/registry";
import { featureLayer, platformForOrganizer } from "./layers";
import {
  eventFeatureKeys,
  featureUsageOrganizer,
  featureUsagePageSchema,
  featureUsageRawSchema,
  type FeatureUsageRawOrganizer,
} from "./usage";

const registries: Registries = {
  features: {
    shop: { gated: false },
    ratings: { gated: false, eventOffByDefault: true },
    streak: { gated: false, level: "platform" },
    boosts: { gated: false },
    screen: { gated: true },
  },
  tuning: {},
};
const ID = "6f1f2d0e-5a4b-4f4e-9c1a-0a1b2c3d4e5f";

const raw = (patch: Partial<FeatureUsageRawOrganizer> = {}): FeatureUsageRawOrganizer => ({
  id: ID,
  name: "Najd Events",
  slug: "najd",
  events: 10,
  more: false,
  overrides: {},
  switches: {},
  unlocked: {},
  using: {},
  ...patch,
});
const rowOf = (patch: Partial<FeatureUsageRawOrganizer>, platform = {}, key = "shop") =>
  featureUsageOrganizer(registries, platform, raw(patch)).features.find((row) => row.key === key);

describe("eventFeatureKeys", () => {
  it("lists the features with an event layer in key order and leaves the Questify-wide ones out", () => {
    expect(eventFeatureKeys(registries)).toEqual(["boosts", "ratings", "screen", "shop"]);
  });

  it("names the sixteen event-level features of the app today", () => {
    expect(eventFeatureKeys(REGISTRIES)).toEqual([
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

describe("featureUsageOrganizer", () => {
  it("carries the organizer's identity and one row per event-level feature", () => {
    const view = featureUsageOrganizer(registries, {}, raw({ events: 7, more: true }));
    expect(view).toMatchObject({
      id: ID,
      name: "Najd Events",
      slug: "najd",
      events: 7,
      more: true,
    });
    expect(view.features.map((row) => row.key)).toEqual(["boosts", "ratings", "screen", "shop"]);
  });

  it("counts a default-on feature in every event read except those that switched it off", () => {
    expect(rowOf({ switches: { shop: { on: 0, off: 3 } } })).toMatchObject({
      platformEnabled: true,
      override: null,
      effective: true,
      eventsOn: 7,
    });
    expect(rowOf({})).toMatchObject({ eventsOn: 10 });
    expect(rowOf({ switches: { shop: { on: 2, off: 10 } } })).toMatchObject({ eventsOn: 0 });
  });

  it("counts a feature that is off until the owner switches it on only where the owner did", () => {
    expect(rowOf({}, {}, "ratings")).toMatchObject({ eventsOn: 0 });
    expect(rowOf({ switches: { ratings: { on: 4, off: 1 } } }, {}, "ratings")).toMatchObject({
      eventsOn: 4,
    });
  });

  it("counts an add-on only where Questify unlocked it, whatever the event's own switch says", () => {
    expect(rowOf({}, {}, "screen")).toMatchObject({ addOn: true, eventsOn: 0 });
    expect(
      rowOf({ unlocked: { screen: 3 }, switches: { screen: { on: 0, off: 9 } } }, {}, "screen"),
    ).toMatchObject({ addOn: true, eventsOn: 3 });
  });

  it("shows no event on while the platform switches the feature off", () => {
    const platform = { features: { shop: { enabled: false } } };
    expect(rowOf({}, platform)).toMatchObject({
      platformEnabled: false,
      override: null,
      effective: false,
      eventsOn: 0,
    });
  });

  it("lets Questify's override win over the platform in both directions", () => {
    const off = { features: { shop: { enabled: false } } };
    expect(rowOf({ overrides: { shop: true } }, off)).toMatchObject({
      platformEnabled: false,
      override: true,
      effective: true,
      eventsOn: 10,
    });
    expect(rowOf({ overrides: { shop: false } })).toMatchObject({
      platformEnabled: true,
      override: false,
      effective: false,
      eventsOn: 0,
    });
  });

  it("applies an override to a points-path feature too (T-711b made boosts overridable)", () => {
    expect(rowOf({ overrides: { boosts: false } }, {}, "boosts")).toMatchObject({
      override: false,
      effective: false,
    });
  });

  it("tells a feature nobody used (0) from one the door does not measure (null)", () => {
    expect(rowOf({ using: { shop: 0 } })).toMatchObject({ eventsUsing: 0 });
    expect(rowOf({ using: { shop: 4 } })).toMatchObject({ eventsUsing: 4 });
    expect(rowOf({ using: { shop: 4 } }, {}, "ratings")).toMatchObject({ eventsUsing: null });
  });

  it("never lets a count go below zero when more events switched off than were read", () => {
    expect(rowOf({ events: 2, switches: { shop: { on: 0, off: 5 } } })).toMatchObject({
      eventsOn: 0,
    });
  });

  it("says the same as featureLayer for every event, in every combination of layers", () => {
    const events: EventConfig[] = [
      {},
      { features: { shop: false } },
      { features: { shop: true, ratings: true } },
      { features: { ratings: false }, unlocked: ["screen"] },
      { unlocked: ["screen"], features: { screen: false } },
      { features: { ratings: true, boosts: false } },
    ];
    const switches = (key: string) => ({
      on: events.filter((event) => event.features?.[key] === true).length,
      off: events.filter((event) => event.features?.[key] === false).length,
    });
    const rawFor = (overrides: Record<string, boolean>) =>
      raw({
        events: events.length,
        overrides,
        switches: Object.fromEntries(
          ["shop", "ratings", "boosts", "screen"].map((key) => [key, switches(key)]),
        ),
        unlocked: {
          screen: events.filter((event) => event.unlocked?.includes("screen") === true).length,
        },
      });
    const platforms = [
      {},
      { features: { shop: { enabled: false }, boosts: { enabled: false } } },
      { features: { ratings: { enabled: false }, screen: { enabled: false } } },
    ];
    for (const platform of platforms) {
      for (const overrides of [{}, { shop: false }, { shop: true, ratings: false, screen: true }]) {
        const seen = platformForOrganizer(registries, platform, overrides);
        const view = featureUsageOrganizer(registries, platform, rawFor(overrides));
        for (const row of view.features) {
          const expected = events.filter(
            (event) => featureLayer(registries, seen, event, row.key) === "on",
          ).length;
          expect(
            [row.key, JSON.stringify(platform), JSON.stringify(overrides), row.eventsOn],
            "layer parity",
          ).toEqual([row.key, JSON.stringify(platform), JSON.stringify(overrides), expected]);
        }
      }
    }
  });
});

describe("the shapes", () => {
  it("accepts what the door answers and refuses a field it does not know", () => {
    expect(featureUsageRawSchema.safeParse({ organizers: [raw()] }).success).toBe(true);
    expect(
      featureUsageRawSchema.safeParse({ organizers: [{ ...raw(), email: "a@b.test" }] }).success,
    ).toBe(false);
    expect(featureUsageRawSchema.safeParse({ organizers: [raw({ events: -1 })] }).success).toBe(
      false,
    );
  });

  it("accepts the page the API answers and refuses one with a stray field", () => {
    const page = {
      organizers: [featureUsageOrganizer(registries, {}, raw())],
      nextCursor: null,
    };
    expect(featureUsagePageSchema.safeParse(page).success).toBe(true);
    expect(featureUsagePageSchema.safeParse({ ...page, extra: 1 }).success).toBe(false);
    expect(featureUsagePageSchema.safeParse({ ...page, nextCursor: "not-an-id" }).success).toBe(
      false,
    );
  });
});
