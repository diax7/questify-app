import { describe, expect, it } from "vitest";
import { flagDetailOf, type FlagLine } from "#src/lib/flags.ts";

const LINE: FlagLine = {
  id: "7",
  kind: "burst",
  status: "open",
  resolution: null,
  raisedAt: null,
  player: { enrollmentId: "e1", username: "sara_88" },
  accounts: null,
  scans: 3,
  waiting: 0,
};

describe("flagDetailOf evidence edges", () => {
  it("defaults the scalar fields of a bare case", () => {
    const detail = flagDetailOf({ flag: LINE }, "en");
    expect(detail).toMatchObject({
      note: null,
      resolvedBy: null,
      resolvedAt: null,
      enrollmentStatus: "undefined",
      paused: false,
      phoneAccounts: [],
      gameRounds: [],
      burstScans: [],
      waitingItems: [],
      removals: [],
    });
  });

  it("reads game rounds with defaults and the count of an unlikely round", () => {
    const detail = flagDetailOf(
      {
        flag: {
          ...LINE,
          kind: "minigame",
          evidence: [
            {
              at: "2030-01-01T10:00:00Z",
              questAr: "ازدواج",
              questEn: "Pairs",
              game: "catch",
              level: "hard",
              reason: "unlikely",
              result: { foreseen: 11 },
            },
            { at: 4, questAr: null, questEn: null },
          ],
        },
      },
      "ar",
    );
    expect(detail?.gameRounds).toEqual([
      {
        at: "2030-01-01T10:00:00Z",
        quest: "ازدواج",
        game: "catch",
        level: "hard",
        reason: "unlikely",
        count: { key: "flags.game.count.foreseen", n: 11 },
      },
      { at: null, quest: "", game: "", level: "", reason: "", count: null },
    ]);
    expect(detail?.burstScans).toEqual([]);
  });

  it("reads items and removals in the page's language with their fallbacks", () => {
    const flag = {
      ...LINE,
      enrollmentStatus: "banned",
      waitingItems: [
        { nameAr: "قبعة", nameEn: "Cap", reservedUntil: "2030-01-02T00:00:00Z" },
        { nameAr: null, nameEn: null, reservedUntil: 9 },
        5,
      ],
      removals: [
        { entryId: 3, at: "2030-01-01T11:00:00Z", score: -40, reason: "cheat" },
        { entryId: "x" },
      ],
    };
    expect(flagDetailOf({ flag }, "ar")).toMatchObject({
      enrollmentStatus: "banned",
      waitingItems: [
        { name: "قبعة", reservedUntil: "2030-01-02T00:00:00Z" },
        { name: "", reservedUntil: null },
      ],
      removals: [
        { entryId: "3", at: "2030-01-01T11:00:00Z", score: 40, reason: "cheat" },
        { entryId: "x", at: null, score: 0, reason: null },
      ],
    });
    expect(flagDetailOf({ flag }, "en")?.waitingItems[0]?.name).toBe("Cap");
  });

  it("keeps a shared phone's accounts and ignores a non-array evidence", () => {
    const detail = flagDetailOf(
      {
        flag: {
          ...LINE,
          kind: "shared_device",
          evidence: [{ enrollmentId: 4, username: "omar", lastScanAt: "2030-01-01T10:00:00Z" }],
        },
      },
      "en",
    );
    expect(detail?.phoneAccounts).toEqual([
      { enrollmentId: "4", username: "omar", lastScanAt: "2030-01-01T10:00:00Z" },
    ]);
    expect(flagDetailOf({ flag: { ...LINE, evidence: "nope" } }, "en")?.burstScans).toEqual([]);
  });
});
