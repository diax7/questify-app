import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  REPEAT_MS,
  inviteTokenOf,
  isPlayerCode,
  isRepeat,
  stationResult,
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
      "something_new",
    ]) {
      const result = stationResult({ result: "refused", reason, player: null });
      expect(result?.color === "red" ? MESSAGES[result.reason] : undefined, reason).toBeDefined();
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
