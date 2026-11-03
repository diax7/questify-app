import { describe, expect, it } from "vitest";
import { addOnRow, addOnRows, isSwitchListed, readEventLayers } from "#src/lib/event-layers.ts";

const LAYERS = {
  features: [
    { key: "bigScreen", state: "locked", addOn: true },
    { key: "questRatings", state: "off", addOn: false },
    { key: "shop", state: "on", addOn: false },
  ],
};

describe("readEventLayers", () => {
  it("takes the API's answer as it is", () => {
    expect(readEventLayers(LAYERS)).toEqual(LAYERS);
    expect(readEventLayers({ features: [] })).toEqual({ features: [] });
  });

  it("refuses a changed answer", () => {
    for (const broken of [
      undefined,
      null,
      {},
      { features: [{ key: "shop", state: "hidden", addOn: false }] },
      { features: [{ key: "shop", state: "on" }] },
      { features: [], extra: true },
    ]) {
      expect(readEventLayers(broken), JSON.stringify(broken)).toBeUndefined();
    }
  });
});

describe("isSwitchListed", () => {
  it("is true for a listed switch, false for an unlisted feature, an add-on, and a list not read", () => {
    const layers = readEventLayers(LAYERS) ?? null;
    expect(isSwitchListed(layers, "shop")).toBe(true);
    expect(isSwitchListed(layers, "questRatings")).toBe(true);
    expect(isSwitchListed(layers, "maps")).toBe(false);
    expect(isSwitchListed(layers, "bigScreen")).toBe(false);
    expect(isSwitchListed(null, "shop")).toBe(false);
  });
});

describe("add-on rows", () => {
  it("finds the add-ons the owner sees, locked or not", () => {
    const layers = readEventLayers(LAYERS) ?? null;
    expect(addOnRows(layers).map((row) => [row.key, row.state])).toEqual([["bigScreen", "locked"]]);
    expect(addOnRow(layers, "bigScreen")?.state).toBe("locked");
    expect(addOnRow(layers, "shop")).toBeUndefined();
    expect(addOnRow(null, "bigScreen")).toBeUndefined();
    expect(addOnRows(null)).toEqual([]);
  });
});
