import { describe, expect, it } from "vitest";
import { NEW_LIVE_BLOCK, pollMinutesOf, pollStateOf } from "#src/lib/polls.ts";

const live = { options: [], live: NEW_LIVE_BLOCK };
const at = Date.parse("2030-01-01T10:00:00Z");

describe("pollStateOf (T-306)", () => {
  it("reads a draft, an open and a closed poll, and nothing for other quests", () => {
    const quest = { type: "vote", config: live, pollSentAt: null, closesAt: null };
    expect(pollStateOf(quest, at)).toBe("draft");
    const sent = { ...quest, pollSentAt: "2030-01-01T09:58:00Z" };
    expect(pollStateOf({ ...sent, closesAt: "2030-01-01T10:03:00Z" }, at)).toBe("open");
    expect(pollStateOf({ ...sent, closesAt: "2030-01-01T10:00:00Z" }, at)).toBe("closed");
    expect(pollStateOf({ ...quest, config: { options: [] } }, at)).toBeNull();
    expect(pollStateOf({ ...quest, type: "quiz" }, at)).toBeNull();
  });

  it("reads the minutes, or the default when they are missing", () => {
    expect(pollMinutesOf({ live: { ...NEW_LIVE_BLOCK, minutes: 30 } })).toBe(30);
    expect(pollMinutesOf({})).toBe(5);
  });
});
