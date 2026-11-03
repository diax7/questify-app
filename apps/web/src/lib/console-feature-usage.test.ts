import type { FeatureUsageRow } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  FEATURE_USAGE_API,
  causeKeyOf,
  featureUsagePath,
  featuresOn,
  readFeatureUsagePage,
  usageKeysOf,
} from "#src/lib/console-feature-usage.ts";

const ID = "6f1f2d0e-5a4b-4f4e-9c1a-0a1b2c3d4e5f";
const row = (patch: Partial<FeatureUsageRow> = {}): FeatureUsageRow => ({
  key: "shop",
  addOn: false,
  platformEnabled: true,
  override: null,
  effective: true,
  eventsOn: 3,
  eventsUsing: 1,
  ...patch,
});

describe("featureUsagePath", () => {
  it("leaves out an empty search and a missing cursor", () => {
    expect(featureUsagePath({ q: "", cursor: null })).toBe(FEATURE_USAGE_API);
    expect(featureUsagePath({ q: "   ", cursor: null })).toBe(FEATURE_USAGE_API);
  });

  it("trims and encodes the search and carries the cursor", () => {
    expect(featureUsagePath({ q: " Najd & Co ", cursor: null })).toBe(
      `${FEATURE_USAGE_API}?q=Najd+%26+Co`,
    );
    expect(featureUsagePath({ q: "", cursor: ID })).toBe(`${FEATURE_USAGE_API}?cursor=${ID}`);
    expect(featureUsagePath({ q: "najd", cursor: ID })).toBe(
      `${FEATURE_USAGE_API}?q=najd&cursor=${ID}`,
    );
  });
});

describe("readFeatureUsagePage", () => {
  const page = {
    organizers: [{ id: ID, name: "Najd", slug: "najd", events: 2, more: false, features: [row()] }],
    nextCursor: null,
  };

  it("takes the API's answer as it is", () => {
    expect(readFeatureUsagePage(page)).toEqual(page);
  });

  it("refuses a changed answer", () => {
    for (const broken of [
      undefined,
      {},
      { ...page, nextCursor: "soon" },
      { ...page, extra: 1 },
      { ...page, organizers: [{ ...page.organizers[0], events: "2" }] },
      { ...page, organizers: [{ ...page.organizers[0], features: [{ key: "shop" }] }] },
    ]) {
      expect(readFeatureUsagePage(broken), JSON.stringify(broken)).toBeUndefined();
    }
  });
});

describe("causeKeyOf", () => {
  it("names Questify's override first, whichever way it points", () => {
    expect(causeKeyOf(row({ override: false, effective: false }))).toBe(
      "console.organizer.features.nowOff",
    );
    expect(causeKeyOf(row({ override: true, platformEnabled: false }))).toBe(
      "console.organizer.features.nowOn",
    );
  });

  it("names the platform when it switched the feature off and nothing overrides it", () => {
    expect(causeKeyOf(row({ platformEnabled: false, effective: false }))).toBe(
      "console.organizer.features.platformOff",
    );
  });

  it("names nothing for a feature that simply follows a platform that leaves it on", () => {
    expect(causeKeyOf(row())).toBeNull();
  });
});

describe("usageKeysOf", () => {
  it("says used, or no use yet, for a feature the door measures", () => {
    expect(usageKeysOf(row({ eventsUsing: 4 }))).toEqual({
      line: "console.featureUsage.line",
      use: "console.featureUsage.used",
    });
    expect(usageKeysOf(row({ eventsUsing: 0 }))).toEqual({
      line: "console.featureUsage.line",
      use: "console.featureUsage.noUse",
    });
  });

  it("says nothing about use for a feature with no content of its own", () => {
    expect(usageKeysOf(row({ eventsUsing: null })).use).toBeNull();
  });

  it("says unlocked, not on, for an add-on", () => {
    expect(usageKeysOf(row({ addOn: true })).line).toBe("console.featureUsage.lineAddOn");
  });
});

describe("featuresOn", () => {
  it("counts the features that are on for the organizer", () => {
    expect(featuresOn([row(), row({ effective: false }), row()])).toBe(2);
    expect(featuresOn([])).toBe(0);
  });
});
