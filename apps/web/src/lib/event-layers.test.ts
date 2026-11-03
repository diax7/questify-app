import { describe, expect, it } from "vitest";
import {
  addOnRow,
  addOnRows,
  askButtonOf,
  askState,
  isSwitchListed,
  readEventLayers,
} from "#src/lib/event-layers.ts";

const LAYERS = {
  features: [
    { key: "bigScreen", state: "locked", addOn: true, request: null },
    { key: "questRatings", state: "off", addOn: false, request: null },
    { key: "shop", state: "on", addOn: false, request: null },
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
      { features: [{ key: "shop", state: "on", addOn: false }] },
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

describe("askState", () => {
  const now = Date.parse("2026-11-03T12:00:00.000Z");
  it("offers Ask Questify with no request, and again after an allowed one was locked", () => {
    expect(askState(null, now)).toEqual({ kind: "ask" });
    expect(askState({ status: "allowed", at: "2026-11-01T00:00:00.000Z" }, now)).toEqual({
      kind: "ask",
    });
  });

  it("says Requested while one is open", () => {
    expect(askState({ status: "open", at: "2026-11-03T11:00:00.000Z" }, now)).toEqual({
      kind: "requested",
    });
  });

  it("says Not approved, with Ask again only 24 hours after the decline", () => {
    expect(askState({ status: "declined", at: "2026-11-03T00:00:00.000Z" }, now)).toEqual({
      kind: "declined",
      askAgainAt: "2026-11-04T00:00:00.000Z",
    });
    expect(askState({ status: "declined", at: "2026-11-02T11:59:59.000Z" }, now)).toEqual({
      kind: "declined",
      askAgainAt: null,
    });
  });
});

describe("askButtonOf", () => {
  it("offers Ask Questify, Ask again after the wait, and nothing while requested or waiting", () => {
    expect(askButtonOf({ kind: "ask" })).toBe("ask");
    expect(askButtonOf({ kind: "declined", askAgainAt: null })).toBe("askAgain");
    expect(askButtonOf({ kind: "declined", askAgainAt: "2026-11-04T00:00:00.000Z" })).toBeNull();
    expect(askButtonOf({ kind: "requested" })).toBeNull();
  });
});
