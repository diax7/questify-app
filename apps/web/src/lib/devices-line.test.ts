import { describe, expect, it } from "vitest";
import { devicesOf } from "#src/lib/devices.ts";

const LINE = {
  id: "d1",
  kind: "station",
  label: "Hall B TV",
  quest: { ar: "قاعة", en: "Hall B" },
  client: "Chrome on Android",
  pairedBy: { type: "staff", name: "owner@najd.sa" },
  pairedAt: "2026-10-24T10:00:00.000Z",
  lastSeenAt: "2026-10-24T10:05:00.000Z",
  activated: true,
  status: "active",
  paused: false,
  scans: 4,
};

const one = (change: Record<string, unknown>) => devicesOf({ devices: [{ ...LINE, ...change }] });

describe("a device line, field by field (through devicesOf)", () => {
  it("reads a complete line as it is", () => {
    expect(devicesOf({ devices: [LINE] })).toEqual([LINE]);
  });

  const refused: readonly [string, unknown][] = [
    ["null", null],
    ["a string", "d1"],
    ["a numeric id", { ...LINE, id: 1 }],
    ["a missing id", { ...LINE, id: undefined }],
    ["an unknown kind", { ...LINE, kind: "phone" }],
    ["a missing kind", { ...LINE, kind: undefined }],
    ["an unknown status", { ...LINE, status: "gone" }],
    ["a missing status", { ...LINE, status: undefined }],
    ["a numeric pairedAt", { ...LINE, pairedAt: 1 }],
    ["a missing pairedAt", { ...LINE, pairedAt: undefined }],
    ["a numeric lastSeenAt", { ...LINE, lastSeenAt: 1 }],
    ["a missing lastSeenAt", { ...LINE, lastSeenAt: undefined }],
  ];
  it.each(refused)("refuses a list holding %s", (_name, line) => {
    expect(devicesOf({ devices: [line] })).toBeUndefined();
    expect(devicesOf({ devices: [LINE, line] })).toBeUndefined();
  });

  it.each(["station", "kiosk", "screen"])("accepts the kind %s", (kind) => {
    expect(one({ kind })?.[0]?.kind).toBe(kind);
  });
  it.each(["active", "revoked", "ended"])("accepts the status %s", (status) => {
    expect(one({ status })?.[0]?.status).toBe(status);
  });

  const defaults: readonly [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["a numeric label", { label: 3 }, { label: "" }],
    ["a missing label", { label: undefined }, { label: "" }],
    ["a numeric client", { client: 3 }, { client: "" }],
    ["a missing client", { client: undefined }, { client: "" }],
    ["no quest", { quest: null }, { quest: null }],
    ["a quest that is a string", { quest: "q" }, { quest: null }],
    ["a missing quest", { quest: undefined }, { quest: null }],
    ["a quest with numeric words", { quest: { ar: 1, en: 2 } }, { quest: { ar: null, en: null } }],
    ["a quest with one word", { quest: { en: "Hall" } }, { quest: { ar: null, en: "Hall" } }],
    ["no pairing", { pairedBy: null }, { pairedBy: null }],
    ["a pairing that is a string", { pairedBy: "x" }, { pairedBy: null }],
    ["a missing pairing", { pairedBy: undefined }, { pairedBy: null }],
    [
      "an operator pairing",
      { pairedBy: { type: "operator", name: "Sara" } },
      { pairedBy: { type: "operator", name: "Sara" } },
    ],
    [
      "a pairing of an unknown type",
      { pairedBy: { type: "robot", name: "R2" } },
      { pairedBy: { type: "staff", name: "R2" } },
    ],
    [
      "a pairing with a numeric name",
      { pairedBy: { type: "operator", name: 5 } },
      { pairedBy: { type: "operator", name: null } },
    ],
    ["an empty pairing", { pairedBy: {} }, { pairedBy: { type: "staff", name: null } }],
    ["activated as a string", { activated: "true" }, { activated: false }],
    ["activated as 1", { activated: 1 }, { activated: false }],
    ["activated missing", { activated: undefined }, { activated: false }],
    ["paused as true", { paused: true }, { paused: true }],
    ["paused as a string", { paused: "true" }, { paused: false }],
    ["paused missing", { paused: undefined }, { paused: false }],
    ["scans as a number", { scans: 0 }, { scans: 0 }],
    ["scans as a string", { scans: "7" }, { scans: null }],
    ["scans as null", { scans: null }, { scans: null }],
    ["scans missing", { scans: undefined }, { scans: null }],
  ];
  it.each(defaults)("reads %s", (_name, change, expected) => {
    expect(one(change)).toEqual([{ ...LINE, ...expected }]);
  });

  it("reads every line of a list and refuses anything that is not one", () => {
    expect(devicesOf({ devices: [] })).toEqual([]);
    expect(devicesOf({ devices: [LINE, { ...LINE, id: "d2" }] })?.map((line) => line.id)).toEqual([
      "d1",
      "d2",
    ]);
    expect(devicesOf({ devices: "x" })).toBeUndefined();
    expect(devicesOf({})).toBeUndefined();
    expect(devicesOf(null)).toBeUndefined();
  });
});
