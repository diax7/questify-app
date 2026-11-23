import { describe, expect, it } from "vitest";
import { AUTH_LIMITS } from "#src/auth/limits";
import { isUsable } from "#src/auth/sign-in";
import type { Challenge } from "#src/auth/staff-store";

const USABLE: Challenge = {
  id: "c1",
  staffUserId: "u1",
  codeHash: Buffer.alloc(32),
  attempts: 0,
  resends: 0,
  expired: false,
  consumed: false,
  secondsSinceSent: 0,
};

describe("isUsable, the locked challenge check of the code step and the resend", () => {
  it("takes a fresh challenge and one with a single attempt left", () => {
    expect(AUTH_LIMITS.maxCodeAttempts).toBe(5);
    expect(isUsable(USABLE)).toBe(true);
    expect(isUsable({ ...USABLE, attempts: 4 })).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["consumed", { ...USABLE, consumed: true }],
    ["expired", { ...USABLE, expired: true }],
    ["out of attempts", { ...USABLE, attempts: 5 }],
    ["past its attempts", { ...USABLE, attempts: 6 }],
  ])("refuses a challenge that is %s", (_reason, challenge) => {
    expect(isUsable(challenge)).toBe(false);
  });
});
