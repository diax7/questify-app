import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  REPEAT_MS,
  held,
  inviteTokenOf,
  pendingInviteOf,
  playerOfCode,
  isPlayerCode,
  isRepeat,
  memoryIn,
  stationResult,
  type ScanMemory,
} from "#src/operator/station.ts";

const TOKEN = "A".repeat(49) + "Q";

describe("inviteTokenOf", () => {
  it("reads the dashboard's invite address and the web page's app link", () => {
    expect(inviteTokenOf(`https://questify.nafes.com/ar/op#${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenOf(` https://staging.example/en/op#${TOKEN} `)).toBe(TOKEN);
    expect(inviteTokenOf(`questify://operator-invite/${TOKEN}`)).toBe(TOKEN);
  });

  it.each([
    ["a quest code", `https://questify.nafes.com/q/${TOKEN}`],
    ["plain http", `http://questify.nafes.com/ar/op#${TOKEN}`],
    ["another language", `https://questify.nafes.com/fr/op#${TOKEN}`],
    ["a short token", "https://questify.nafes.com/ar/op#abc"],
    ["a bare token", TOKEN],
    ["no token", "https://questify.nafes.com/ar/op"],
  ])("refuses %s", (_name, text) => {
    expect(inviteTokenOf(text)).toBeNull();
  });
});

describe("isPlayerCode", () => {
  it("takes a bare 50-character token only", () => {
    expect(isPlayerCode(` ${TOKEN} `)).toBe(true);
    expect(isPlayerCode(`https://questify.nafes.com/q/${TOKEN}`)).toBe(false);
    expect(isPlayerCode("short")).toBe(false);
  });
});

describe("stationResult", () => {
  const player = { username: "noura", avatar: "falcon" };

  it("shows green with the points, orange for a repeat, red with words for each reason", () => {
    expect(stationResult({ result: "completed", points: 25, player, occurrence: 1 })).toEqual({
      color: "green",
      points: 25,
      player,
    });
    expect(stationResult({ result: "already_completed", player })).toEqual({
      color: "orange",
      player,
    });
    expect(stationResult({ result: "refused", reason: "not_in_event", player: null })).toEqual({
      color: "red",
      reason: "operator.red.notInEvent",
      player: null,
    });
  });

  it("names every red reason in both languages, and a new one in the general words", () => {
    for (const reason of [
      "invalid_code",
      "old_code",
      "not_in_event",
      "enrollment_inactive",
      "quest_not_open",
      "quest_not_found",
      "ability_off",
      "outside_station",
      "self_scan",
      "operator_not_playing",
      "wrong_method",
      "going_live",
      "something_new",
    ]) {
      const result = stationResult({ result: "refused", reason, player: null });
      // Read through the shape, not the union of every message: the full union is too large for the compiler.
      const messages: Readonly<Record<string, Readonly<{ ar: string; en: string }>>> = MESSAGES;
      const message = result?.color === "red" ? messages[result.reason] : undefined;
      expect(message, reason).toBeDefined();
    }
  });

  it("reads nothing it does not understand", () => {
    expect(stationResult(null)).toBeUndefined();
    expect(stationResult({ result: "completed" })).toBeUndefined();
    expect(stationResult({ result: "maybe" })).toBeUndefined();
    expect(stationResult({ result: "orange", player: { username: 3 } })).toBeUndefined();
    expect(stationResult({ result: "already_completed", player: { username: 3 } })).toEqual({
      color: "orange",
      player: null,
    });
  });
});

describe("isRepeat", () => {
  const last = { code: TOKEN, questId: "q1", at: 1000 };

  it("holds the same code at the same station for 5 seconds", () => {
    expect(isRepeat(last, TOKEN, "q1", 1000 + REPEAT_MS - 1)).toBe(true);
    expect(isRepeat(last, TOKEN, "q1", 1000 + REPEAT_MS)).toBe(false);
    expect(isRepeat(last, TOKEN, "q2", 1001)).toBe(false);
    expect(isRepeat(last, "B".repeat(50), "q1", 1001)).toBe(false);
    expect(isRepeat(null, TOKEN, "q1", 1001)).toBe(false);
  });
});

describe("the sliding repeat window", () => {
  it("keeps a code held up for 12 seconds, read every second, as one scan", () => {
    let last = { code: TOKEN, questId: "q1", at: 0 };
    let scans = 1;
    for (let now = 1000; now <= 12_000; now += 1000) {
      if (isRepeat(last, TOKEN, "q1", now)) {
        last = held(last, now);
      } else {
        scans += 1;
        last = { code: TOKEN, questId: "q1", at: now };
      }
    }
    expect(scans).toBe(1);
    expect(isRepeat(last, TOKEN, "q1", 12_000 + REPEAT_MS)).toBe(false);
  });
});

describe("pendingInviteOf", () => {
  it("carries a token-shaped invite through sign-in and drops anything else", () => {
    expect(pendingInviteOf({ invite: TOKEN })).toBe(TOKEN);
    expect(pendingInviteOf({ invite: "short" })).toBeUndefined();
    expect(pendingInviteOf({ invite: [TOKEN] })).toBeUndefined();
    expect(pendingInviteOf({})).toBeUndefined();
  });
});

describe("playerOfCode", () => {
  const PLAYER = "5b1f0c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
  const codeOf = (format: number) =>
    Buffer.concat([
      Buffer.from([format]),
      Buffer.from(PLAYER.replaceAll("-", ""), "hex"),
      Buffer.from([0, 0, 0, 1]),
      Buffer.alloc(16, 7),
    ]).toString("base64url");

  it("reads the player a My QR names, and nothing from other codes", () => {
    expect(playerOfCode(codeOf(0x02))).toBe(PLAYER);
    expect(playerOfCode(codeOf(0x01))).toBeNull();
    expect(playerOfCode("short")).toBeNull();
  });
});

describe("memoryIn (CTO plan review, MAJOR-1)", () => {
  const CODE = "B".repeat(50);
  const practised: ScanMemory = {
    practice: true,
    last: { code: CODE, questId: "q1", at: 1000 },
    attempt: { code: CODE, questId: "q1", key: "k1" },
  };

  it("keeps the last code and its key while the mode stays", () => {
    expect(memoryIn(practised, true)).toBe(practised);
  });

  it("forgets them when practice is left, so the code still in the camera is scanned for real", () => {
    const real = memoryIn(practised, false);
    expect(real).toEqual({ practice: false, last: null, attempt: null });
    expect(isRepeat(real.last, CODE, "q1", 1500)).toBe(false);
  });

  it("forgets a real scan's code when practice is turned on, so it is practised", () => {
    const afterReal: ScanMemory = { ...practised, practice: false };
    expect(memoryIn(afterReal, true)).toEqual({ practice: true, last: null, attempt: null });
  });
});
