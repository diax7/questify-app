import { describe, expect, it } from "vitest";
import {
  OVERRIDE_CHOICES,
  bodyOf,
  choiceOf,
  organizerFeaturePath,
  organizerFeaturesPath,
  readOrganizerFeatures,
  shownChoice,
} from "#src/lib/console-organizer-features.ts";

describe("paths", () => {
  it("name the organizer and the feature", () => {
    expect(organizerFeaturesPath("o-1")).toBe("/v1/admin/organizers/o-1/features");
    expect(organizerFeaturePath("o-1", "shop")).toBe("/v1/admin/organizers/o-1/features/shop");
    expect(organizerFeaturePath("a/b", "x y")).toBe("/v1/admin/organizers/a%2Fb/features/x%20y");
  });
});

describe("readOrganizerFeatures", () => {
  const row = { key: "shop", platformEnabled: false, override: true, effective: true };

  it("takes the API's answer as it is", () => {
    expect(readOrganizerFeatures({ features: [row] })).toEqual({ features: [row] });
  });

  it("refuses a changed answer", () => {
    for (const broken of [
      undefined,
      {},
      { features: [{ ...row, override: "yes" }] },
      { features: [{ key: "shop" }] },
      { features: [], extra: 1 },
    ]) {
      expect(readOrganizerFeatures(broken), JSON.stringify(broken)).toBeUndefined();
    }
  });
});

describe("the select's choices", () => {
  it("map an override to a choice and a choice to the request", () => {
    expect(OVERRIDE_CHOICES).toEqual(["platform", "off", "on"]);
    expect([null, false, true].map(choiceOf)).toEqual(["platform", "off", "on"]);
    expect(OVERRIDE_CHOICES.map(bodyOf)).toEqual([null, { enabled: false }, { enabled: true }]);
  });
});

describe("shownChoice", () => {
  const shop = { key: "shop", override: null };

  it("shows the stored choice when nothing is pending", () => {
    expect(shownChoice(shop, null)).toBe("platform");
    expect(shownChoice({ key: "shop", override: false }, null)).toBe("off");
  });

  it("shows the choice just made for its own feature until the list is read again", () => {
    expect(shownChoice(shop, { key: "shop", choice: "on" })).toBe("on");
  });

  it("leaves the other features on their stored choice", () => {
    expect(shownChoice({ key: "maps", override: true }, { key: "shop", choice: "off" })).toBe("on");
  });
});
