import { describe, expect, it } from "vitest";
import { AUTH_LIMITS } from "#src/auth/limits";
import { capRefusal } from "#src/organizers/team";

const PENDING = AUTH_LIMITS.invitesPending;
const { activated: ACTIVATED, notActivated: NOT_ACTIVATED } = AUTH_LIMITS.invitesPerDay;

const today = (count: number) => ({ count, retryAfterSeconds: 120 });

describe("capRefusal, the invite caps after the organizer's facts are read", () => {
  it("admits one below each limit", () => {
    expect(capRefusal({ pending: PENDING - 1, activated: false }, today(NOT_ACTIVATED - 1))).toBe(
      undefined,
    );
    expect(capRefusal({ pending: PENDING - 1, activated: true }, today(ACTIVATED - 1))).toBe(
      undefined,
    );
  });

  it("answers a full pending list first, even when the day is used up too", () => {
    expect(capRefusal({ pending: PENDING, activated: false }, today(NOT_ACTIVATED))).toEqual({
      kind: "pending_full",
    });
  });

  it("holds an organizer that is not activated to the lower daily limit", () => {
    expect(capRefusal({ pending: 0, activated: false }, today(NOT_ACTIVATED))).toEqual({
      kind: "throttled",
      retryAfterSeconds: 120,
    });
    expect(capRefusal({ pending: 0, activated: true }, today(NOT_ACTIVATED))).toBe(undefined);
  });

  it("holds an activated organizer at its own daily limit", () => {
    expect(capRefusal({ pending: 0, activated: true }, today(ACTIVATED))).toEqual({
      kind: "throttled",
      retryAfterSeconds: 120,
    });
  });
});
