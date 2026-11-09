import { describe, expect, it } from "vitest";
import { cardParts, isJoinedResult, joinButton } from "#src/join/card-view.ts";

const RESULTS = [
  undefined,
  "active",
  "pending",
  "waitlisted",
  "full",
  "already",
  "network",
  "not_found",
  "throttled",
  "stale",
  "constructor",
] as const;

// The join screen's inline conditions as they read before they moved out of it.
const oldJoined = (result: string | undefined) =>
  result === "active" || result === "pending" || result === "waitlisted" || result === "already";
const oldLabel = (full: boolean, isPrivate: boolean) =>
  full ? "join.waitlistJoin" : isPrivate ? "joinCard.request" : "joinCard.join";

describe("isJoinedResult", () => {
  it.each<[string | undefined, boolean]>([
    [undefined, false],
    ["active", true],
    ["pending", true],
    ["waitlisted", true],
    ["already", true],
    ["full", false],
    ["network", false],
    ["not_found", false],
    ["throttled", false],
    ["stale", false],
    ["constructor", false],
  ])("%s -> %s", (result, joined) => {
    expect(isJoinedResult(result)).toBe(joined);
    expect(oldJoined(result)).toBe(joined);
  });
});

describe("cardParts", () => {
  it.each<[string, boolean, boolean, number, boolean, boolean]>([
    ["an open card", false, false, 0, false, true],
    ["a joined card with a welcome reward", true, false, 50, true, false],
    ["a joined card with no reward", true, false, 0, false, false],
    ["a welcome is only shown once joined", false, false, 50, false, true],
    ["an ended event has no join form", false, true, 0, false, false],
    ["an ended event, joined, with a reward", true, true, 20, true, false],
  ])("%s", (_name, joined, ended, welcome, showWelcome, showJoin) => {
    expect(cardParts(joined, ended, welcome)).toEqual({ welcome: showWelcome, join: showJoin });
  });

  it("matches the old inline conditions for every combination", () => {
    for (const joined of [false, true]) {
      for (const ended of [false, true]) {
        for (const welcome of [-1, 0, 1, 50]) {
          expect(cardParts(joined, ended, welcome)).toEqual({
            welcome: joined && welcome > 0,
            join: !(ended || joined),
          });
        }
      }
    }
  });
});

describe("joinButton", () => {
  type Input = Parameters<typeof joinButton>[0];
  const base: Input = {
    result: undefined,
    isPrivate: false,
    busy: false,
    cardMissing: false,
    playerLoading: false,
  };

  it.each<[string, Partial<Input>, string, boolean, boolean]>([
    ["a public event", {}, "joinCard.join", false, false],
    ["a private event asks to join", { isPrivate: true }, "joinCard.request", false, false],
    ["a full event offers the waiting list", { result: "full" }, "join.waitlistJoin", false, true],
    [
      "a full private event is still the waiting list",
      { result: "full", isPrivate: true },
      "join.waitlistJoin",
      false,
      true,
    ],
    ["a join in flight turns it off", { busy: true }, "joinCard.join", true, false],
    ["no card yet turns it off", { cardMissing: true }, "joinCard.join", true, false],
    ["a player still loading turns it off", { playerLoading: true }, "joinCard.join", true, false],
    ["another outcome changes nothing", { result: "stale" }, "joinCard.join", false, false],
  ])("%s", (_name, fields, label, disabled, waitlist) => {
    expect(joinButton({ ...base, ...fields })).toEqual({ label, disabled, waitlist });
  });

  it("matches the old inline button for every combination", () => {
    for (const result of RESULTS) {
      for (const isPrivate of [false, true]) {
        for (const busy of [false, true]) {
          for (const cardMissing of [false, true]) {
            for (const playerLoading of [false, true]) {
              expect(joinButton({ result, isPrivate, busy, cardMissing, playerLoading })).toEqual({
                label: oldLabel(result === "full", isPrivate),
                disabled: busy || cardMissing || playerLoading,
                waitlist: result === "full",
              });
            }
          }
        }
      }
    }
  });
});
