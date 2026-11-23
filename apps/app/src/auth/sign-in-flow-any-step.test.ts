import { describe, expect, it } from "vitest";
import {
  signInStep,
  type PendingJoin,
  type SignInEvent,
  type SignInState,
} from "#src/auth/sign-in-flow.ts";

const VERSIONS = { terms: "0.1", privacy: "0.1" };
const NEW_VERSIONS = { terms: "0.2", privacy: "0.1" };
const JOIN: PendingJoin = { code: "ABC234", via: "link", cardVersion: "0.1" };
const PROBLEM = { ar: "خطأ", en: "Error" };
const CARRIED = { versions: VERSIONS, channel: "phone" as const, pending: JOIN };

const LIVE: readonly SignInState[] = [
  { step: "consent", versions: VERSIONS, problem: null, pending: JOIN },
  { step: "contact", ...CARRIED, problem: null, offerEmail: false, previous: undefined },
  {
    step: "code",
    ...CARRIED,
    contact: "+966551234567",
    challengeToken: "token",
    resendAt: 1,
    emailOfferAt: null,
    attemptsLeft: null,
    problem: null,
  },
  { step: "profile", ...CARRIED, signupToken: "signup", problem: null },
];

const ENDED: readonly SignInState[] = [
  { step: "done", join: JOIN },
  { step: "banned", notice: { reason: null, appealEmail: "appeals@example.com" } },
  { step: "closed" },
];

const EVENTS: readonly SignInEvent[] = [
  { type: "closed" },
  { type: "signed_in" },
  { type: "versions_changed", versions: NEW_VERSIONS, problem: PROBLEM },
];

describe("the events every step answers the same way", () => {
  it.each(LIVE.map((state) => [state.step, state] as const))(
    "closes, signs in or asks the consent again from the %s step",
    (_step, state) => {
      expect(signInStep(state, { type: "closed" })).toEqual({ step: "closed" });
      expect(signInStep(state, { type: "signed_in" })).toEqual({ step: "done", join: JOIN });
      expect(
        signInStep(state, { type: "versions_changed", versions: NEW_VERSIONS, problem: PROBLEM }),
      ).toEqual({ step: "consent", versions: NEW_VERSIONS, problem: PROBLEM, pending: JOIN });
    },
  );

  it.each(ENDED.map((state) => [state.step, state] as const))(
    "leaves the %s step as it is",
    (_step, state) => {
      for (const event of EVENTS) {
        expect(signInStep(state, event)).toBe(state);
      }
    },
  );

  it("stays on the consent when it is accepted without versions in force", () => {
    const state: SignInState = {
      step: "consent",
      versions: undefined,
      problem: null,
      pending: JOIN,
    };
    expect(signInStep(state, { type: "accepted" })).toBe(state);
  });
});
