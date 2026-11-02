import {
  FEATURES,
  TUNING,
  buildSwitchesView,
  REGISTRIES,
  type FeatureRow,
  type TuningRow,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  checkMessage,
  featureBody,
  featurePath,
  isMessageDirty,
  messageDraftOf,
  nameKeyOf,
  numberFor,
  readSwitches,
  tuningPath,
  wholeNumberOf,
} from "./console-switches.ts";

const ROW: FeatureRow = {
  key: "shop",
  platformOnly: false,
  addOn: false,
  enabled: false,
  defaultEnabled: true,
  changed: true,
  message: { ar: "متوقف", en: "Paused" },
};
const NUMBER: TuningRow = {
  key: "readinessDays",
  value: 14,
  default: 14,
  min: 1,
  max: 60,
  changed: false,
  serverOnly: true,
};

describe("the switches page", () => {
  it("names every feature and number of the app, so no row shows a bare key", () => {
    for (const key of Object.keys(FEATURES)) {
      expect(nameKeyOf("feature", key), key).toBeDefined();
    }
    for (const key of Object.keys(TUNING)) {
      expect(nameKeyOf("number", key), key).toBeDefined();
    }
    expect(nameKeyOf("feature", "teleporter")).toBeUndefined();
    expect(nameKeyOf("feature", "constructor")).toBeUndefined();
  });

  it("reads the API's view and refuses another shape", () => {
    const view = buildSwitchesView(REGISTRIES, {});
    expect(readSwitches(view)).toEqual(view);
    expect(readSwitches({ features: [] })).toBeUndefined();
    expect(readSwitches(undefined)).toBeUndefined();
  });

  it("builds escaped API paths", () => {
    expect(featurePath("shop")).toBe("/v1/admin/switches/features/shop");
    expect(tuningPath("a/b")).toBe("/v1/admin/switches/tuning/a%2Fb");
  });
});

describe("the players' message", () => {
  it("is none when both boxes are empty, and both languages trimmed when both are filled", () => {
    expect(checkMessage({ ar: " ", en: "" })).toEqual({ ok: true, message: null });
    expect(checkMessage({ ar: " متوقف ", en: " Paused " })).toEqual({
      ok: true,
      message: { ar: "متوقف", en: "Paused" },
    });
  });

  it("refuses one language alone, naming the empty one, and a message over 300 characters", () => {
    expect(checkMessage({ ar: "متوقف", en: "" })).toEqual({
      ok: false,
      fields: new Set(["message.en"]),
    });
    expect(checkMessage({ ar: "", en: "Paused" })).toEqual({
      ok: false,
      fields: new Set(["message.ar"]),
    });
    expect(checkMessage({ ar: "ا".repeat(301), en: "x" }).ok).toBe(false);
  });

  it("goes with a switch-off only, and only when usable", () => {
    expect(featureBody(true, messageDraftOf(ROW))).toEqual({ enabled: true, message: null });
    expect(featureBody(false, messageDraftOf(ROW))).toEqual({
      enabled: false,
      message: ROW.message,
    });
    expect(featureBody(false, { ar: "متوقف", en: "" })).toEqual({ enabled: false, message: null });
  });

  it("is dirty when it differs from the saved one", () => {
    expect(isMessageDirty(ROW, messageDraftOf(ROW))).toBe(false);
    expect(isMessageDirty(ROW, { ar: "متوقف", en: " Paused " })).toBe(false);
    expect(isMessageDirty(ROW, { ar: "متوقف", en: "Resting" })).toBe(true);
    expect(isMessageDirty({ ...ROW, message: null }, { ar: "", en: "" })).toBe(false);
  });
});

describe("a tuning number", () => {
  it.each([
    ["12", 12],
    [" 7 ", 7],
    ["1.5", Number.NaN],
    ["", Number.NaN],
    ["1e3", Number.NaN],
    ["-3", Number.NaN],
    ["12345678901", Number.NaN],
  ])("reads %j as %s", (text, expected) => {
    expect(wholeNumberOf(text)).toBe(expected);
  });

  it("is usable only inside the row's range, both ends included", () => {
    expect(numberFor(NUMBER, "1")).toBe(1);
    expect(numberFor(NUMBER, "60")).toBe(60);
    expect(numberFor(NUMBER, "0")).toBeUndefined();
    expect(numberFor(NUMBER, "61")).toBeUndefined();
    expect(numberFor(NUMBER, "abc")).toBeUndefined();
  });
});
