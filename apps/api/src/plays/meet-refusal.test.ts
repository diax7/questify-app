import { describe, expect, it } from "vitest";
import { capOf, meetRefusalOf, metNameOf } from "#src/plays/meet";

describe("metNameOf", () => {
  it("names the other player on already_met from the hint", () => {
    expect(metNameOf("already_met", "sara")).toBe("sara");
  });

  it("is null on already_met without a hint", () => {
    expect(metNameOf("already_met", undefined)).toBeNull();
  });

  it("is null for every other reason", () => {
    expect(metNameOf("daily_cap", "sara")).toBeNull();
  });
});

describe("capOf", () => {
  it("reads the cap on daily_cap", () => {
    expect(capOf("daily_cap", "12")).toBe(12);
  });

  it("is null on daily_cap when the hint is not a number or missing", () => {
    expect(capOf("daily_cap", "many")).toBeNull();
    expect(capOf("daily_cap", undefined)).toBeNull();
  });

  it("is null for every other reason", () => {
    expect(capOf("their_daily_cap", "12")).toBeNull();
  });
});

describe("meetRefusalOf", () => {
  it("maps a QM error with a known reason", () => {
    expect(meetRefusalOf({ code: "QM422", detail: "expired" })).toEqual({
      kind: "meet_refused",
      reason: "expired",
      name: null,
      cap: null,
    });
  });

  it("carries the name and the cap from the hint", () => {
    expect(meetRefusalOf({ code: "QM409", detail: "already_met", hint: "sara" })).toEqual({
      kind: "meet_refused",
      reason: "already_met",
      name: "sara",
      cap: null,
    });
    expect(meetRefusalOf({ code: "QM409", detail: "daily_cap", hint: "5" })).toEqual({
      kind: "meet_refused",
      reason: "daily_cap",
      name: null,
      cap: 5,
    });
  });

  it("takes each of the three QM codes", () => {
    for (const code of ["QM422", "QM409", "QM403"]) {
      expect(meetRefusalOf({ code, detail: "self" })?.reason).toBe("self");
    }
  });

  it("is undefined for another code, no code, an unknown reason or no reason", () => {
    expect(meetRefusalOf({ code: "QX422", detail: "self" })).toBeUndefined();
    expect(meetRefusalOf({ detail: "self" })).toBeUndefined();
    expect(meetRefusalOf({ code: "QM422", detail: "nope" })).toBeUndefined();
    expect(meetRefusalOf({ code: "QM422" })).toBeUndefined();
  });
});
