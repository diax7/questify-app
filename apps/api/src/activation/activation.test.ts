import { describe, expect, it } from "vitest";
import type { Registries } from "@questify/shared";
import {
  MAX_PLAYER_LIMIT,
  activationStateOf,
  checkAddons,
  checkLimit,
  isEventFull,
  refusalOf,
} from "#src/activation/activation";

const registries: Registries = {
  features: { bigScreen: { gated: true }, kiosks: { gated: true }, shop: { gated: false } },
  tuning: {},
};

describe("checkLimit", () => {
  it("takes no number with none", () => {
    expect(checkLimit({ mode: "none" })).toEqual({ mode: "none", value: null });
    expect(checkLimit({ mode: "none", value: null })).toEqual({ mode: "none", value: null });
    expect(checkLimit({ mode: "none", value: 5 })).toBeUndefined();
  });

  it("needs a whole number from 1 to the maximum with soft and hard", () => {
    expect(checkLimit({ mode: "soft", value: 300 })).toEqual({ mode: "soft", value: 300 });
    expect(checkLimit({ mode: "hard", value: 1 })).toEqual({ mode: "hard", value: 1 });
    expect(checkLimit({ mode: "hard", value: MAX_PLAYER_LIMIT })).toEqual({
      mode: "hard",
      value: MAX_PLAYER_LIMIT,
    });
    for (const value of [undefined, null, 0, -1, 2.5, MAX_PLAYER_LIMIT + 1, Number.NaN]) {
      expect(checkLimit({ mode: "hard", value }), String(value)).toBeUndefined();
      expect(checkLimit({ mode: "soft", value }), String(value)).toBeUndefined();
    }
  });
});

describe("checkAddons", () => {
  it("keeps gated features once each, sorted", () => {
    expect(checkAddons(["kiosks", "bigScreen", "kiosks"], registries)).toEqual({
      ok: true,
      addons: ["bigScreen", "kiosks"],
    });
    expect(checkAddons([], registries)).toEqual({ ok: true, addons: [] });
  });

  it("names the first feature that is not an add-on", () => {
    expect(checkAddons(["bigScreen", "shop", "teleporter"], registries)).toEqual({
      ok: false,
      unknown: "shop",
    });
    expect(checkAddons(["teleporter"], registries)).toEqual({ ok: false, unknown: "teleporter" });
  });
});

describe("isEventFull", () => {
  it("is true only for the limit's own SQLSTATE", () => {
    expect(isEventFull({ code: "QL409" })).toBe(true);
    expect(isEventFull({ code: "QE409" })).toBe(false);
    expect(isEventFull(new Error("QL409"))).toBe(false);
    expect(isEventFull(null)).toBe(false);
    expect(isEventFull(undefined)).toBe(false);
  });
});

describe("refusalOf", () => {
  it("maps each definer refusal", () => {
    expect(refusalOf({ code: "QE403" })).toEqual({ kind: "forbidden" });
    expect(refusalOf({ code: "QA404" })).toEqual({ kind: "not_found" });
    expect(refusalOf({ code: "QE409" })).toEqual({ kind: "conflict" });
    expect(refusalOf({ code: "QA409" })).toEqual({ kind: "conflict" });
    expect(refusalOf({ code: "QA422", detail: "venue" })).toEqual({
      kind: "invalid",
      field: "venue",
    });
    expect(refusalOf({ code: "QA422", detail: "times" })).toEqual({
      kind: "invalid",
      field: "times",
    });
    expect(refusalOf({ code: "QA422" })).toEqual({ kind: "invalid", field: "times" });
  });

  it("leaves anything else to be rethrown", () => {
    expect(refusalOf({ code: "23505" })).toBeUndefined();
    expect(refusalOf({ code: 42 })).toBeUndefined();
    expect(refusalOf(new Error("boom"))).toBeUndefined();
    expect(refusalOf(null)).toBeUndefined();
    expect(refusalOf({ code: "toString" })).toBeUndefined();
  });
});

describe("activationStateOf", () => {
  it("calls every status past draft activated, whatever the request says", () => {
    for (const status of ["scheduled", "live", "ended", "archived"]) {
      expect(activationStateOf(status, undefined)).toBe("activated");
      expect(activationStateOf(status, { state: "pending" })).toBe("activated");
    }
  });

  it("reads a draft by its request", () => {
    expect(activationStateOf("draft", undefined)).toBe("not_requested");
    expect(activationStateOf("draft", { state: "pending" })).toBe("requested");
    expect(activationStateOf("draft", { state: "rejected" })).toBe("rejected");
  });
});
