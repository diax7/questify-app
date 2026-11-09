import { describe, expect, it } from "vitest";
import { completionAnswer } from "#src/event/quests-api.ts";

const message = { ar: "خطأ", en: "Error" };
const error = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => ({
  kind: "error" as const,
  status,
  code,
  message,
  details,
  headers: new Headers(headers),
});

describe("a refused completion, branch by branch", () => {
  it.each([
    [{ reason: "no_position", distanceM: 5 }, "no_position", 5],
    [{ reason: "bad_position", distanceM: 0 }, "bad_position", 0],
    [{ reason: "stale" }, "stale", null],
    [{ reason: "imprecise", distanceM: "9" }, "imprecise", null],
    [{ reason: "not_here", distanceM: 140.5 }, "not_here", 140.5],
    [{ reason: "newer", distanceM: 3 }, undefined, 3],
    [{}, undefined, null],
    [{ reason: null, distanceM: null }, undefined, null],
  ])("a refused check-in %o", (details, reason, distanceM) => {
    expect(completionAnswer(error(422, "location_refused", details))).toEqual({
      kind: "location_refused",
      reason,
      distanceM,
    });
  });

  it.each([
    [{ reason: "bad_code", name: "Sara", cap: 3 }, "bad_code", "Sara", 3],
    [{ reason: "expired" }, "expired", null, null],
    [{ reason: "used", name: 5, cap: "3" }, "used", null, null],
    [{ reason: "self" }, "self", null, null],
    [{ reason: "same_device" }, "same_device", null, null],
    [{ reason: "already_met", name: "Omar" }, "already_met", "Omar", null],
    [{ reason: "daily_cap", cap: 0 }, "daily_cap", null, 0],
    [{ reason: "their_daily_cap", cap: 2 }, "their_daily_cap", null, 2],
    [{ reason: "done" }, "done", null, null],
    [{ reason: "their_done" }, "their_done", null, null],
    [{ reason: "not_in_event" }, "not_in_event", null, null],
    [{ reason: "not_for_them" }, "not_for_them", null, null],
    [{ reason: "off" }, undefined, null, null],
    [{ reason: "unknown", name: "", cap: 1 }, undefined, "", 1],
    [{}, undefined, null, null],
  ])("a refused meeting %o", (details, reason, name, cap) => {
    expect(completionAnswer(error(422, "meet_refused", details))).toEqual({
      kind: "meet_refused",
      reason,
      name,
      cap,
    });
  });

  it.each(["invalid_code", "code_expired"])("%s reads as a wrong code", (code) => {
    expect(completionAnswer(error(422, code))).toEqual({ kind: "wrong_code", problem: message });
  });

  it.each([
    "event_not_live",
    "hidden",
    "paused",
    "not_started",
    "ended",
    "not_for_you",
    "community_locked",
    "category_not_started",
    "category_locked",
    "order_locked",
  ])("a quest that is not open: %s", (reason) => {
    expect(completionAnswer(error(403, "quest_not_open", { reason }))).toEqual({
      kind: "not_open",
      reason,
    });
  });

  it.each([{ reason: "newer_reason" }, { reason: null }, {}])(
    "a quest that is not open for a reason this app does not know: %o",
    (details) => {
      expect(completionAnswer(error(403, "quest_not_open", details))).toEqual({
        kind: "not_open",
        reason: undefined,
      });
    },
  );

  it.each([
    ["feature_off", 403, { kind: "location_off" }],
    ["already_completed", 409, { kind: "limit" }],
    ["enrollment_inactive", 403, { kind: "reload" }],
    ["not_found", 404, { kind: "reload" }],
    ["not_found", 400, { kind: "reload" }],
    ["other", 404, { kind: "reload" }],
    ["other", 500, { kind: "failed" }],
    ["other", 422, { kind: "failed" }],
  ])("%s with status %i", (code, status, expected) => {
    expect(completionAnswer(error(status, code))).toEqual(expected);
  });

  it.each([
    ["120", 120],
    ["1.5", 1.5],
    ["0", null],
    ["-5", null],
    ["abc", null],
    ["Infinity", null],
    ["", null],
  ])("too many attempts with retry-after %j", (value, seconds) => {
    expect(completionAnswer(error(429, "too_many_attempts", {}, { "retry-after": value }))).toEqual(
      { kind: "wait", seconds },
    );
  });

  it("too many attempts without retry-after", () => {
    expect(completionAnswer(error(429, "too_many_attempts"))).toEqual({
      kind: "wait",
      seconds: null,
    });
  });
});
