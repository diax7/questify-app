import { describe, expect, it } from "vitest";
import { moveTargets, tagsOf } from "#src/lib/nfc-tags.ts";
import type { CategoryView } from "#src/lib/quests.ts";

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

const quest = (id: string, type: string, verification: string[]) => ({
  id,
  type,
  verification,
  title: { ar: null, en: id },
});

describe("tagsOf", () => {
  it("reads the panel's list, and nothing that is not one", () => {
    expect(tagsOf({ tags: [TAG] })).toEqual([TAG]);
    expect(tagsOf({ tags: [] })).toEqual([]);
    expect(tagsOf({ tags: [{ ...TAG, status: "lost" }] })).toBeUndefined();
    expect(tagsOf({ tags: [{ ...TAG, copies: "1" }] })).toBeUndefined();
    expect(tagsOf({ tags: [{ ...TAG, writtenBy: 4 }] })).toBeUndefined();
    expect(tagsOf({})).toBeUndefined();
    expect(tagsOf(null)).toBeUndefined();
  });
});

describe("moveTargets", () => {
  it("offers the event's other scan quests with NFC on", () => {
    const categories = [
      {
        quests: [
          quest("self", "scan_qr", ["quest_qr", "nfc"]),
          quest("other", "scan_qr", ["quest_qr", "nfc"]),
          quest("plain", "scan_qr", ["quest_qr"]),
        ],
      },
      { quests: [quest("far", "scan_qr", ["quest_qr", "my_qr", "nfc"])] },
    ] as unknown as CategoryView[];
    expect(moveTargets(categories, "self").map((target) => target.id)).toEqual(["other", "far"]);
  });
});
