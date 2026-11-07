import { describe, expect, it } from "vitest";
import { isInEvent, joinedResult, type Joined } from "#src/join/join-result.ts";

const joined = (overrides: Partial<Joined>): Joined => ({
  kind: "joined",
  eventId: "evt_1",
  status: "active",
  alreadyMember: false,
  welcome: 0,
  waitlisted: false,
  ...overrides,
});

describe("what a join that went through says", () => {
  it("says active for a new member and already for one who was in", () => {
    expect(joinedResult(joined({}))).toBe("active");
    expect(joinedResult(joined({ alreadyMember: true }))).toBe("already");
  });

  it("says pending for a request that waits for approval, new or repeated", () => {
    expect(joinedResult(joined({ status: "pending" }))).toBe("pending");
    expect(joinedResult(joined({ status: "pending", alreadyMember: true }))).toBe("pending");
  });

  it("says waitlisted for a place on the waiting list, before anything else", () => {
    expect(joinedResult(joined({ status: "pending", waitlisted: true }))).toBe("waitlisted");
    expect(joinedResult(joined({ status: "pending", waitlisted: true, alreadyMember: true }))).toBe(
      "waitlisted",
    );
  });
});

describe("whether the player is in the event now", () => {
  it("is yes for a new member and for one who was already in", () => {
    expect(isInEvent("active")).toBe(true);
    expect(isInEvent("already")).toBe(true);
  });

  it("is no for a request waiting for approval, a waiting-list place and every other state", () => {
    for (const result of [
      "pending",
      "waitlisted",
      "full",
      "network",
      "not_found",
      "throttled",
      "stale",
      undefined,
    ] as const) {
      expect(isInEvent(result), String(result)).toBe(false);
    }
  });

  it("follows the status the API gave for every join it can answer", () => {
    const possible: readonly Joined[] = [
      joined({ status: "active" }),
      joined({ status: "active", alreadyMember: true }),
      joined({ status: "pending" }),
      joined({ status: "pending", alreadyMember: true }),
      joined({ status: "pending", waitlisted: true }),
    ];
    for (const outcome of possible) {
      expect(isInEvent(joinedResult(outcome)), JSON.stringify(outcome)).toBe(
        outcome.status === "active",
      );
    }
  });
});
