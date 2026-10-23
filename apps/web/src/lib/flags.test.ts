import { describe, expect, it } from "vitest";
import { flagDetailOf, flagSummary, resolutionKey, type FlagLine } from "#src/lib/flags.ts";

const LINE: FlagLine = {
  id: "7",
  kind: "burst",
  status: "open",
  resolution: null,
  raisedAt: null,
  player: { enrollmentId: "e1", username: "sara_88" },
  accounts: null,
  scans: 12,
  waiting: 0,
};

describe("flagSummary", () => {
  it("names a burst by its scans and a shared phone by its accounts", () => {
    expect(flagSummary(LINE)).toEqual({ key: "flags.kind.burst", count: 12 });
    expect(flagSummary({ ...LINE, scans: null })).toEqual({ key: "flags.kind.burst", count: 0 });
    expect(flagSummary({ ...LINE, kind: "shared_device", accounts: 3 })).toEqual({
      key: "flags.kind.sharedDevice",
      count: 3,
    });
    expect(flagSummary({ ...LINE, kind: "shared_device", accounts: null }).count).toBe(2);
  });
});

describe("resolutionKey", () => {
  it("words each ending", () => {
    expect(resolutionKey("cleared")).toBe("flags.resolution.cleared");
    expect(resolutionKey("points_removed")).toBe("flags.resolution.pointsRemoved");
    expect(resolutionKey("banned")).toBe("flags.resolution.banned");
    expect(resolutionKey(null)).toBe("flags.resolution.cleared");
  });
});

describe("flagDetailOf", () => {
  it("reads a burst's scans in the page's language, its waiting items and its removals", () => {
    const body = {
      flag: {
        ...LINE,
        note: "fast",
        resolvedBy: null,
        resolvedAt: null,
        enrollmentStatus: "active",
        paused: true,
        evidence: [
          { at: "2030-01-01T10:00:00Z", questAr: "الأسد", questEn: "Lion", operator: "op_1" },
          { at: 5, questAr: null, questEn: "Tiger", operator: null },
          "broken",
        ],
        waitingItems: [{ nameAr: null, nameEn: "Hoodie", reservedUntil: "2030-01-01T12:00:00Z" }],
        removals: [{ entryId: 9, at: "2030-01-01T11:00:00Z", score: -50, reason: "cheat" }],
      },
    };
    expect(flagDetailOf(body, "ar")).toMatchObject({
      paused: true,
      note: "fast",
      phoneAccounts: [],
      burstScans: [
        { at: "2030-01-01T10:00:00Z", quest: "الأسد", operator: "op_1" },
        { at: null, quest: "Tiger", operator: null },
      ],
      waitingItems: [{ name: "Hoodie", reservedUntil: "2030-01-01T12:00:00Z" }],
      removals: [{ entryId: "9", score: 50, reason: "cheat" }],
    });
    expect(flagDetailOf(body, "en")?.burstScans[0]?.quest).toBe("Lion");
  });

  it("reads a shared phone's accounts, and refuses what is not a case", () => {
    const shared = flagDetailOf(
      {
        flag: {
          ...LINE,
          kind: "shared_device",
          evidence: [{ enrollmentId: "e2", username: "omar", lastScanAt: null }],
        },
      },
      "en",
    );
    expect(shared).toMatchObject({
      phoneAccounts: [{ enrollmentId: "e2", username: "omar", lastScanAt: null }],
      burstScans: [],
      waitingItems: [],
      removals: [],
      paused: false,
    });
    expect(flagDetailOf({}, "en")).toBeUndefined();
    expect(flagDetailOf({ flag: { id: 7, player: {} } }, "en")).toBeUndefined();
    expect(flagDetailOf({ flag: { id: "7" } }, "en")).toBeUndefined();
  });
});
