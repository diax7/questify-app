import { describe, expect, it } from "vitest";
import {
  signInStep,
  startSignIn,
  type PendingJoin,
  type SignInEvent,
  type SignInState,
} from "#src/auth/sign-in-flow.ts";

const VERSIONS = { terms: "0.1", privacy: "0.1" };
const JOIN: PendingJoin = { code: "ABC234", via: "link", cardVersion: "0.1" };
const PROBLEM = { ar: "خطأ", en: "Error" };

const run = (state: SignInState, ...events: SignInEvent[]) => events.reduce(signInStep, state);

/** Up to the code step; null means no join is waiting (undefined would take the default). */
const toCode = (pending: PendingJoin | null = JOIN) =>
  run(
    startSignIn(pending ?? undefined),
    { type: "versions_loaded", versions: VERSIONS },
    { type: "accepted" },
    {
      type: "code_sent",
      contact: "+966551234567",
      challengeToken: "token",
      now: 1_000,
      resendAfterSeconds: 60,
      emailFallbackAfterSeconds: 30,
    },
  );

describe("the sign-in flow", () => {
  it("goes from consent to contact to code, with the resend and email-offer times", () => {
    expect(toCode()).toEqual({
      step: "code",
      versions: VERSIONS,
      channel: "phone",
      contact: "+966551234567",
      challengeToken: "token",
      resendAt: 61_000,
      emailOfferAt: 31_000,
      attemptsLeft: null,
      problem: null,
      pending: JOIN,
    });
  });

  it("asks for no code without the versions in force", () => {
    const stuck = run(
      startSignIn(undefined),
      { type: "versions_loaded", versions: undefined },
      { type: "accepted" },
    );
    expect(stuck).toEqual({
      step: "consent",
      versions: undefined,
      problem: null,
      pending: undefined,
    });
    expect(run(startSignIn(undefined), { type: "accepted" }).step).toBe("consent");
  });

  it("switches the contact step's channel, and offers email for a number it cannot text", () => {
    const contact = run(
      startSignIn(undefined),
      { type: "versions_loaded", versions: VERSIONS },
      { type: "accepted" },
    );
    expect(run(contact, { type: "refused", problem: PROBLEM, offerEmail: true })).toMatchObject({
      step: "contact",
      problem: PROBLEM,
      offerEmail: true,
    });
    expect(
      run(
        contact,
        { type: "refused", problem: PROBLEM, offerEmail: true },
        { type: "channel_chosen", channel: "email" },
      ),
    ).toMatchObject({ step: "contact", channel: "email", problem: null, offerEmail: false });
    expect(run(contact, { type: "refused", problem: PROBLEM })).toMatchObject({
      offerEmail: false,
    });
  });

  it("counts wrong codes, resends with fresh tries, and goes back on an ended code", () => {
    const wrong = run(toCode(), { type: "wrong_code", attemptsLeft: 2, problem: PROBLEM });
    expect(wrong).toMatchObject({ step: "code", attemptsLeft: 2, problem: PROBLEM });
    expect(run(wrong, { type: "resent", now: 70_000, resendAfterSeconds: 60 })).toMatchObject({
      step: "code",
      resendAt: 130_000,
      attemptsLeft: null,
      problem: null,
    });
    expect(run(wrong, { type: "refused", problem: PROBLEM })).toMatchObject({
      step: "code",
      problem: PROBLEM,
    });
    expect(run(wrong, { type: "expired", problem: PROBLEM })).toEqual({
      step: "contact",
      versions: VERSIONS,
      channel: "phone",
      problem: PROBLEM,
      offerEmail: false,
      pending: JOIN,
    });
  });

  it("takes the email offer from the code step (FR-1812)", () => {
    expect(run(toCode(), { type: "channel_chosen", channel: "email" })).toMatchObject({
      step: "contact",
      channel: "email",
      pending: JOIN,
    });
  });

  it("has no email offer for an email code", () => {
    const state = run(
      startSignIn(undefined),
      { type: "versions_loaded", versions: VERSIONS },
      { type: "accepted" },
      { type: "channel_chosen", channel: "email" },
      {
        type: "code_sent",
        contact: "a@b.sa",
        challengeToken: "t",
        now: 0,
        resendAfterSeconds: 60,
        emailFallbackAfterSeconds: null,
      },
    );
    expect(state).toMatchObject({ step: "code", channel: "email", emailOfferAt: null });
  });

  describe("the pending join", () => {
    it("survives the profile step of a new player and fires once on success", () => {
      const profile = run(toCode(), { type: "new_player", signupToken: "signup" });
      expect(profile).toEqual({
        step: "profile",
        versions: VERSIONS,
        channel: "phone",
        signupToken: "signup",
        problem: null,
        pending: JOIN,
      });
      const refused = run(profile, { type: "refused", problem: PROBLEM });
      expect(refused).toMatchObject({ step: "profile", problem: PROBLEM, pending: JOIN });
      const done = run(refused, { type: "signed_in" });
      expect(done).toEqual({ step: "done", join: JOIN });
      expect(run(done, { type: "signed_in" })).toBe(done);
    });

    it("hands a returning player's join on at sign-in", () => {
      expect(run(toCode(), { type: "signed_in" })).toEqual({ step: "done", join: JOIN });
      expect(run(toCode(null), { type: "signed_in" })).toEqual({
        step: "done",
        join: undefined,
      });
    });

    it("is dropped when the person closes sign-in, at any step", () => {
      for (const state of [
        startSignIn(JOIN),
        toCode(),
        run(toCode(), { type: "new_player", signupToken: "s" }),
      ]) {
        const closed = run(state, { type: "closed" });
        expect(closed).toEqual({ step: "closed" });
        expect(run(closed, { type: "signed_in" })).toEqual({ step: "closed" });
      }
    });
  });

  it("ignores events that do not belong to the step", () => {
    const consent = startSignIn(undefined);
    for (const event of [
      { type: "resent", now: 0, resendAfterSeconds: 60 },
      { type: "wrong_code", attemptsLeft: 1, problem: null },
      { type: "new_player", signupToken: "s" },
    ] as const) {
      expect(run(consent, event)).toBe(consent);
    }
    const code = toCode();
    expect(run(code, { type: "versions_loaded", versions: VERSIONS })).toBe(code);
    const profile = run(code, { type: "new_player", signupToken: "s" });
    expect(run(profile, { type: "accepted" })).toBe(profile);
    const contact = run(
      startSignIn(undefined),
      { type: "versions_loaded", versions: VERSIONS },
      { type: "accepted" },
    );
    expect(run(contact, { type: "accepted" })).toBe(contact);
  });

  it("goes back to a new code when the signup token ends on the profile step, keeping the join", () => {
    const profile = run(toCode(), { type: "new_player", signupToken: "s" });
    expect(run(profile, { type: "expired", problem: PROBLEM })).toEqual({
      step: "contact",
      versions: VERSIONS,
      channel: "phone",
      pending: JOIN,
      problem: PROBLEM,
      offerEmail: false,
      previous: undefined,
    });
  });

  it("asks for the consent again with the new versions when the terms changed, at any step", () => {
    const NEW = { terms: "0.2", privacy: "0.1" };
    const contact = run(
      startSignIn(JOIN),
      { type: "versions_loaded", versions: VERSIONS },
      { type: "accepted" },
    );
    for (const state of [contact, toCode()]) {
      expect(run(state, { type: "versions_changed", versions: NEW, problem: PROBLEM })).toEqual({
        step: "consent",
        versions: NEW,
        problem: PROBLEM,
        pending: JOIN,
      });
    }
    const consent = run(contact, { type: "versions_changed", versions: NEW, problem: PROBLEM });
    expect(run(consent, { type: "accepted" })).toMatchObject({
      step: "contact",
      versions: NEW,
      problem: null,
    });
  });

  it("names the SMS challenge when the person switches to email, so it ends (FR-1812)", () => {
    expect(run(toCode(), { type: "channel_chosen", channel: "email" })).toMatchObject({
      step: "contact",
      channel: "email",
      previous: "token",
    });
    const contact = run(
      startSignIn(undefined),
      { type: "versions_loaded", versions: VERSIONS },
      { type: "accepted" },
    );
    expect(contact).toMatchObject({ previous: undefined });
  });

  it("does nothing more once done or closed", () => {
    const done = run(toCode(), { type: "signed_in" });
    for (const event of [
      { type: "closed" },
      { type: "expired", problem: null },
      { type: "versions_changed", versions: undefined, problem: null },
    ] as const) {
      expect(run(done, event)).toBe(done);
    }
  });
});
