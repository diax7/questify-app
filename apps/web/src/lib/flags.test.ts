import { describe, expect, it } from "vitest";
import {
  flagDetailOf,
  flagSummary,
  gameRoundText,
  lengthText,
  locationNotes,
  methodLabel,
  unlikelyCount,
  resolutionKey,
  type FlagLine,
  type Scan,
} from "#src/lib/flags.ts";
import { translatorFor } from "#src/lib/language.ts";

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

describe("flagSummary for location cases", () => {
  it("names a far-from-venue and an impossible-speed case by their scans", () => {
    expect(flagSummary({ ...LINE, kind: "far_from_venue", scans: 3 })).toEqual({
      key: "flags.kind.farFromVenue",
      count: 3,
    });
    expect(flagSummary({ ...LINE, kind: "impossible_speed", scans: null })).toEqual({
      key: "flags.kind.impossibleSpeed",
      count: 0,
    });
  });
});

describe("lengthText", () => {
  const en = translatorFor("en");
  const ar = translatorFor("ar");

  it("says metres under a kilometre and kilometres to one decimal from there", () => {
    expect(lengthText(0, "en", en)).toBe("0 m");
    expect(lengthText(910, "en", en)).toBe("910 m");
    expect(lengthText(999, "en", en)).toBe("999 m");
    expect(lengthText(1000, "en", en)).toBe("1 km");
    expect(lengthText(2430, "en", en)).toBe("2.4 km");
    expect(lengthText(12_350, "en", en)).toBe("12.4 km");
  });

  it("uses Western digits in Arabic, with the Arabic unit", () => {
    expect(lengthText(910, "ar", ar)).toBe("910 م");
    expect(lengthText(2430, "ar", ar)).toBe("2.4 كم");
  });
});

describe("methodLabel", () => {
  it("labels a meeting's two sides and nothing else", () => {
    expect(methodLabel("meet_scan")).toBe("flags.method.meetScan");
    expect(methodLabel("meet_shown")).toBe("flags.method.meetShown");
    expect(methodLabel("qr")).toBeNull();
    expect(methodLabel(null)).toBeNull();
  });
});

describe("locationNotes", () => {
  const en = translatorFor("en");
  const SCAN: Scan = {
    at: null,
    quest: "Gate A",
    operator: null,
    method: null,
    distanceM: 2400,
    accuracyM: 30,
    mocked: false,
    gapM: 910,
    seconds: 40,
  };

  it("says how far from the venue a scan was, and how precise the reading", () => {
    expect(locationNotes("far_from_venue", SCAN, "en", en)).toEqual([
      "2.4 km from the venue (±30 m)",
    ]);
    expect(locationNotes("far_from_venue", { ...SCAN, distanceM: 850 }, "en", en)).toEqual([
      "850 m from the venue (±30 m)",
    ]);
  });

  it("adds the fake-location line when the phone reported one", () => {
    expect(locationNotes("far_from_venue", { ...SCAN, mocked: true }, "en", en)).toEqual([
      "2.4 km from the venue (±30 m)",
      "The phone reported a fake location",
    ]);
    expect(
      locationNotes("far_from_venue", { ...SCAN, distanceM: null, mocked: true }, "en", en),
    ).toEqual(["The phone reported a fake location"]);
  });

  it("says nothing for a far scan without a distance or a mark", () => {
    expect(
      locationNotes(
        "far_from_venue",
        { ...SCAN, distanceM: null, accuracyM: null, mocked: null },
        "en",
        en,
      ),
    ).toEqual([]);
  });

  it("says the gap and the seconds for an impossible-speed scan, nothing for the first", () => {
    expect(locationNotes("impossible_speed", SCAN, "en", en)).toEqual([
      "910 m in 40 s from the previous spot",
    ]);
    expect(
      locationNotes("impossible_speed", { ...SCAN, gapM: null, seconds: null }, "en", en),
    ).toEqual([]);
  });

  it("says nothing for the other kinds, whatever the scan holds", () => {
    expect(locationNotes("burst", SCAN, "en", en)).toEqual([]);
    expect(locationNotes("shared_device", SCAN, "en", en)).toEqual([]);
  });

  it("writes Arabic lines with Western digits", () => {
    const ar = translatorFor("ar");
    expect(locationNotes("far_from_venue", SCAN, "ar", ar)[0]).toBe(
      "على بُعد 2.4 كم من مكان الفعالية (±30 م)",
    );
    expect(locationNotes("impossible_speed", SCAN, "ar", ar)).toEqual([
      "910 م خلال 40 ث من المكان السابق",
    ]);
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

describe("flagDetailOf for location cases", () => {
  it("reads each scan's rounded distances and marks, and null for what is missing", () => {
    const detail = flagDetailOf(
      {
        flag: {
          ...LINE,
          kind: "far_from_venue",
          evidence: [
            {
              at: "2030-01-01T10:00:00Z",
              questAr: null,
              questEn: "Gate A",
              operator: null,
              distanceM: 2400,
              accuracyM: 30,
              mocked: true,
              gapM: null,
              seconds: null,
            },
            { at: null, questAr: null, questEn: "Hall C", distanceM: "far", mocked: "yes" },
          ],
        },
      },
      "en",
    );
    expect(detail?.burstScans).toMatchObject([
      { distanceM: 2400, accuracyM: 30, mocked: true, gapM: null, seconds: null },
      { distanceM: null, accuracyM: null, mocked: null, gapM: null, seconds: null },
    ]);
  });
});

describe("mini-game cases", () => {
  const en = translatorFor("en");
  it("count their rounds and list each with its game, level and reason", () => {
    expect(flagSummary({ ...LINE, kind: "minigame", scans: 2 })).toEqual({
      key: "flags.kind.minigame",
      count: 2,
    });
    const detail = flagDetailOf(
      {
        flag: {
          ...LINE,
          kind: "minigame",
          enrollmentStatus: "active",
          evidence: [
            {
              at: "2030-01-01T10:00:00Z",
              roundId: 4,
              game: "memory_match",
              level: "hard",
              reason: "too_fast",
              verdict: "refused",
              questAr: null,
              questEn: "Pairs",
            },
          ],
        },
      },
      "en",
    );
    expect(detail?.burstScans).toEqual([]);
    expect(detail?.gameRounds).toEqual([
      {
        at: "2030-01-01T10:00:00Z",
        quest: "Pairs",
        game: "memory_match",
        level: "hard",
        reason: "too_fast",
        count: null,
      },
    ]);
    const round = detail?.gameRounds[0];
    expect(round === undefined ? null : gameRoundText(round, "10:00", en)).toEqual({
      line: "10:00: Pairs (Memory match, Hard)",
      reason: "Taps faster than a person can make",
    });
    expect(
      gameRoundText({ at: null, quest: "Q", game: "darts", level: "pro", reason: "new" }, "", en),
    ).toEqual({ line: ": Q (darts, pro)", reason: null });
    expect(
      gameRoundText(
        { at: null, quest: "Q", game: "slide_puzzle", level: "easy", reason: "unlikely" },
        "",
        en,
      ).reason,
    ).toBe("Possible but unusual result (paid)");
    const count = { key: "flags.game.count.foreseen", n: 11 } as const;
    expect(
      gameRoundText(
        { at: null, quest: "Q", game: "catch", level: "hard", reason: "unlikely", count },
        "",
        en,
      ).reason,
    ).toBe("Possible but unusual result (paid) (foreseen 11)");
  });

  it("reads the count that made a paid round unlikely (T-305c)", () => {
    expect(unlikelyCount({ caught: 40, missed: 0, foreseen: 12 })).toEqual({
      key: "flags.game.count.foreseen",
      n: 12,
    });
    expect(unlikelyCount({ hits: 50, misses: 0, score: 50, quick: 9 })).toEqual({
      key: "flags.game.count.quick",
      n: 9,
    });
    expect(unlikelyCount({ pairs: 6, moves: 6, ms: 900, lucky: 4 })).toEqual({
      key: "flags.game.count.lucky",
      n: 4,
    });
    expect(unlikelyCount({ solved: true, moves: 9, ms: 900 })).toBeNull();
    expect(unlikelyCount(null)).toBeNull();
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
          {
            at: "2030-01-01T10:00:00Z",
            questAr: "الأسد",
            questEn: "Lion",
            operator: "op_1",
            method: "meet_scan",
          },
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
        { at: "2030-01-01T10:00:00Z", quest: "الأسد", operator: "op_1", method: "meet_scan" },
        { at: null, quest: "Tiger", operator: null, method: null },
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
