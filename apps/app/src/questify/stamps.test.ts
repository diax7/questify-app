import { describe, expect, it } from "vitest";
import type { OwnEvent } from "@questify/shared";
import { INTERESTS_METRIC } from "@questify/shared";
import {
  clampedProgress,
  emblemOf,
  endsIn,
  opensInterests,
  stampState,
  stateText,
} from "#src/questify/stamps.ts";

type Case = Pick<OwnEvent, "rankState" | "rank" | "eventStatus">;
const event = (patch: Partial<Case>): Case => ({
  rankState: "live",
  rank: null,
  eventStatus: "live",
  ...patch,
});

describe("stampState", () => {
  it("calls a draft or scheduled membership upcoming, not live", () => {
    expect(stampState(event({ eventStatus: "draft" }))).toEqual({ kind: "upcoming" });
    expect(stampState(event({ eventStatus: "scheduled" }))).toEqual({ kind: "upcoming" });
  });

  it("calls a running event live and gives it no rank", () => {
    expect(stampState(event({ eventStatus: "live", rank: 3 }))).toEqual({ kind: "live" });
  });

  it("says results are pending once the event ended and before they are revealed", () => {
    expect(stampState(event({ rankState: "pending", eventStatus: "ended" }))).toEqual({
      kind: "pending",
    });
  });

  it("shows the final rank only when the results are final and there is one", () => {
    const final = event({ rankState: "final", eventStatus: "ended" });
    expect(stampState({ ...final, rank: 4 })).toEqual({ kind: "final", rank: 4 });
    expect(stampState({ ...final, rank: null })).toEqual({ kind: "unranked" });
  });

  it("reads an unranked result as not ranked", () => {
    expect(stampState(event({ rankState: "unranked", eventStatus: "archived" }))).toEqual({
      kind: "unranked",
    });
  });
});

describe("stateText", () => {
  it("names a message for every state, the rank as a value", () => {
    expect(stateText({ kind: "upcoming" }).key).toBe("passport.upcoming");
    expect(stateText({ kind: "live" }).key).toBe("passport.live");
    expect(stateText({ kind: "pending" }).key).toBe("passport.rankPending");
    expect(stateText({ kind: "unranked" }).key).toBe("passport.unranked");
    expect(stateText({ kind: "final", rank: 7 })).toEqual({
      key: "passport.rank",
      params: { rank: 7 },
    });
  });
});

describe("emblemOf", () => {
  const name = { ar: "مهرجان الرياض", en: "riyadh fest" };

  it("takes the first letter of the name in the screen's language", () => {
    expect(emblemOf(name, "en")).toBe("R");
    expect(emblemOf(name, "ar")).toBe("م");
  });

  it("falls back to the other language when one name is empty, and to a mark when both are", () => {
    expect(emblemOf({ ar: "", en: "Fest" }, "ar")).toBe("F");
    expect(emblemOf({ ar: "", en: "  " }, "en")).toBe("?");
  });

  it("keeps a letter outside the basic plane whole", () => {
    expect(emblemOf({ ar: "", en: "😀 party" }, "en")).toBe("😀");
  });
});

// 2026-11-10 21:00 UTC is 2026-11-11 00:00 in Riyadh.
const riyadhMidnight = new Date("2026-11-10T21:00:00Z");
const keyAt = (days: number) =>
  endsIn(
    new Date(riyadhMidnight.getTime() + days * 86_400_000 + 3_600_000).toISOString(),
    riyadhMidnight,
  )?.key;

describe("endsIn", () => {
  it("says today for the same Saudi calendar day", () => {
    expect(endsIn("2026-11-11T20:00:00Z", riyadhMidnight)).toEqual({
      key: "questifyQuests.endsToday",
      days: 0,
    });
  });

  it("counts Saudi calendar days, not 24-hour blocks", () => {
    const lateEvening = new Date("2026-11-11T20:30:00Z");
    expect(endsIn("2026-11-12T02:00:00Z", lateEvening)).toEqual({
      key: "questifyQuests.endsInOne",
      days: 1,
    });
  });

  it("picks Arabic's one, two, few and many forms", () => {
    expect(keyAt(1)).toBe("questifyQuests.endsInOne");
    expect(keyAt(2)).toBe("questifyQuests.endsInTwo");
    expect(keyAt(3)).toBe("questifyQuests.endsInFew");
    expect(keyAt(10)).toBe("questifyQuests.endsInFew");
    expect(keyAt(11)).toBe("questifyQuests.endsInMany");
    expect(keyAt(40)).toBe("questifyQuests.endsInMany");
  });

  it("is null once the end has passed or cannot be read", () => {
    expect(endsIn("2026-11-10T20:59:59Z", riyadhMidnight)).toBeNull();
    expect(endsIn("2026-11-10T21:00:00Z", riyadhMidnight)).toBeNull();
    expect(endsIn("soon", riyadhMidnight)).toBeNull();
  });
});

describe("clampedProgress", () => {
  it("never shows more than the target or less than none", () => {
    expect(clampedProgress(5, 3)).toBe(3);
    expect(clampedProgress(2, 3)).toBe(2);
    expect(clampedProgress(-1, 3)).toBe(0);
  });
});

describe("opensInterests (T-407c)", () => {
  it("offers the Interests screen for an undone interests quest only", () => {
    expect(opensInterests({ metric: INTERESTS_METRIC, done: false })).toBe(true);
    expect(opensInterests({ metric: INTERESTS_METRIC, done: true })).toBe(false);
    expect(opensInterests({ metric: "events", done: false })).toBe(false);
    expect(opensInterests({ metric: "follow", done: false })).toBe(false);
  });
});
