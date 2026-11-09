import { describe, expect, it } from "vitest";
import { tagsOf } from "#src/lib/nfc-tags.ts";

const TAG = {
  id: "t1",
  label: "Gate",
  locked: true,
  status: "active",
  writtenAt: "2026-10-24T10:00:00.000Z",
  writtenBy: "sara",
  taps: 3,
  copies: 1,
  unchecked: 0,
  lastTapAt: null,
};

describe("a tag line, field by field (through tagsOf)", () => {
  const accepted: readonly [string, Record<string, unknown>][] = [
    ["the plain tag", {}],
    ["a revoked tag", { status: "revoked" }],
    ["an unlocked tag", { locked: false }],
    ["a tag written by nobody", { writtenBy: null }],
    ["a tag tapped before", { lastTapAt: "2026-10-24T11:00:00.000Z" }],
    ["a tag with no taps", { taps: 0, copies: 0, unchecked: 0 }],
    ["a tag with an extra field", { extra: 1 }],
  ];
  it.each(accepted)("keeps %s", (_name, change) => {
    const tag = { ...TAG, ...change };
    expect(tagsOf({ tags: [tag] })).toEqual([tag]);
  });

  const refused: readonly [string, Record<string, unknown>][] = [
    ["a numeric id", { id: 1 }],
    ["a missing id", { id: undefined }],
    ["a numeric label", { label: 1 }],
    ["a missing label", { label: undefined }],
    ["a string locked", { locked: "true" }],
    ["a missing locked", { locked: undefined }],
    ["an unknown status", { status: "lost" }],
    ["a missing status", { status: undefined }],
    ["a numeric writtenAt", { writtenAt: 1 }],
    ["a missing writtenAt", { writtenAt: undefined }],
    ["a numeric writtenBy", { writtenBy: 4 }],
    ["a missing writtenBy", { writtenBy: undefined }],
    ["a string taps", { taps: "3" }],
    ["a missing taps", { taps: undefined }],
    ["a string copies", { copies: "1" }],
    ["a missing copies", { copies: undefined }],
    ["a string unchecked", { unchecked: "0" }],
    ["a missing unchecked", { unchecked: undefined }],
    ["a numeric lastTapAt", { lastTapAt: 1 }],
    ["a missing lastTapAt", { lastTapAt: undefined }],
  ];
  it.each(refused)("refuses %s", (_name, change) => {
    expect(tagsOf({ tags: [{ ...TAG, ...change }] })).toBeUndefined();
    expect(tagsOf({ tags: [TAG, { ...TAG, ...change }] })).toBeUndefined();
  });

  it.each([null, "x", 5, undefined])("refuses a tag that is %s", (tag) => {
    expect(tagsOf({ tags: [tag] })).toBeUndefined();
  });

  it("reads lists", () => {
    expect(tagsOf({ tags: [] })).toEqual([]);
    expect(tagsOf({ tags: "x" })).toBeUndefined();
    expect(tagsOf(null)).toBeUndefined();
    expect(tagsOf({})).toBeUndefined();
  });
});
