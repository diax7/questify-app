import type { LocalizedText, SignupAcceptance } from "@questify/shared";

/**
 * A join the person tapped before signing in (ADR-089): it waits in memory through sign-in, the profile step
 * included, and fires once after success. Never stored, so a later launch cannot join on its own.
 */
export type PendingJoin = Readonly<{
  code: string;
  via: "code" | "qr" | "link" | "public_list";
  cardVersion: string;
}>;

export type Channel = "phone" | "email";

type Problem = LocalizedText | null;

/** Where the sign-in stands. Each screen renders one step; nothing here talks to the network. */
export type SignInState =
  | Readonly<{
      step: "consent";
      versions: SignupAcceptance | undefined;
      pending: PendingJoin | undefined;
    }>
  | Readonly<{
      step: "contact";
      versions: SignupAcceptance;
      channel: Channel;
      problem: Problem;
      /** A non-Saudi number was typed: the screen offers email (FR-108). */
      offerEmail: boolean;
      pending: PendingJoin | undefined;
    }>
  | Readonly<{
      step: "code";
      versions: SignupAcceptance;
      channel: Channel;
      contact: string;
      challengeToken: string;
      /** When the resend button wakes (ms), and, for a phone, when the email offer shows (FR-1812). */
      resendAt: number;
      emailOfferAt: number | null;
      attemptsLeft: number | null;
      problem: Problem;
      pending: PendingJoin | undefined;
    }>
  | Readonly<{
      step: "profile";
      signupToken: string;
      problem: Problem;
      pending: PendingJoin | undefined;
    }>
  | Readonly<{ step: "done"; join: PendingJoin | undefined }>
  | Readonly<{ step: "closed" }>;

export type SignInEvent =
  | Readonly<{ type: "versions_loaded"; versions: SignupAcceptance | undefined }>
  | Readonly<{ type: "accepted" }>
  | Readonly<{ type: "channel_chosen"; channel: Channel }>
  | Readonly<{
      type: "code_sent";
      contact: string;
      challengeToken: string;
      now: number;
      resendAfterSeconds: number;
      emailFallbackAfterSeconds: number | null;
    }>
  | Readonly<{ type: "resent"; now: number; resendAfterSeconds: number }>
  | Readonly<{ type: "refused"; problem: Problem; offerEmail?: boolean }>
  | Readonly<{ type: "wrong_code"; attemptsLeft: number; problem: Problem }>
  | Readonly<{ type: "expired"; problem: Problem }>
  | Readonly<{ type: "new_player"; signupToken: string }>
  | Readonly<{ type: "signed_in" }>
  | Readonly<{ type: "closed" }>;

/** The first step: the consent, carrying the join the person tapped, if any. */
export function startSignIn(pending: PendingJoin | undefined): SignInState {
  return { step: "consent", versions: undefined, pending };
}

const pendingOf = (state: SignInState): PendingJoin | undefined =>
  state.step === "done" || state.step === "closed" ? undefined : state.pending;

function fromCode(state: Extract<SignInState, { step: "code" }>, event: SignInEvent): SignInState {
  switch (event.type) {
    case "resent":
      return {
        ...state,
        resendAt: event.now + event.resendAfterSeconds * 1000,
        attemptsLeft: null,
        problem: null,
      };
    case "wrong_code":
      return { ...state, attemptsLeft: event.attemptsLeft, problem: event.problem };
    case "refused":
      return { ...state, problem: event.problem };
    // An ended code goes back to the contact step: a new code is a new request.
    case "expired":
      return {
        step: "contact",
        versions: state.versions,
        channel: state.channel,
        problem: event.problem,
        offerEmail: false,
        pending: state.pending,
      };
    case "new_player":
      return {
        step: "profile",
        signupToken: event.signupToken,
        problem: null,
        pending: state.pending,
      };
    case "channel_chosen":
      // The email offer after 30 seconds (FR-1812): back to the contact step on email.
      return {
        step: "contact",
        versions: state.versions,
        channel: event.channel,
        problem: null,
        offerEmail: false,
        pending: state.pending,
      };
    default:
      return state;
  }
}

/**
 * Moves the sign-in on. Closing drops everything, the pending join included (closing sign-in joins nothing, ADR-089);
 * signing in hands the pending join on exactly once.
 */
export function signInStep(state: SignInState, event: SignInEvent): SignInState {
  if (event.type === "closed") {
    return { step: "closed" };
  }
  if (event.type === "signed_in" && state.step !== "done" && state.step !== "closed") {
    return { step: "done", join: pendingOf(state) };
  }
  switch (state.step) {
    case "consent":
      if (event.type === "versions_loaded") {
        return { ...state, versions: event.versions };
      }
      // No versions in force, no consent, and so no code request (T-110).
      if (event.type === "accepted" && state.versions !== undefined) {
        return {
          step: "contact",
          versions: state.versions,
          channel: "phone",
          problem: null,
          offerEmail: false,
          pending: state.pending,
        };
      }
      return state;
    case "contact":
      if (event.type === "channel_chosen") {
        return { ...state, channel: event.channel, problem: null, offerEmail: false };
      }
      if (event.type === "refused") {
        return { ...state, problem: event.problem, offerEmail: event.offerEmail === true };
      }
      if (event.type === "code_sent") {
        return {
          step: "code",
          versions: state.versions,
          channel: state.channel,
          contact: event.contact,
          challengeToken: event.challengeToken,
          resendAt: event.now + event.resendAfterSeconds * 1000,
          emailOfferAt:
            event.emailFallbackAfterSeconds === null
              ? null
              : event.now + event.emailFallbackAfterSeconds * 1000,
          attemptsLeft: null,
          problem: null,
          pending: state.pending,
        };
      }
      return state;
    case "code":
      return fromCode(state, event);
    case "profile":
      return event.type === "refused" ? { ...state, problem: event.problem } : state;
    default:
      return state;
  }
}
