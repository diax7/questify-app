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

/** What every step after the consent keeps, so an ended code or signup token can go back without losing anything. */
type Carried = Readonly<{
  versions: SignupAcceptance;
  channel: Channel;
  pending: PendingJoin | undefined;
}>;

/** Where the sign-in stands. Each screen renders one step; nothing here talks to the network. */
export type SignInState =
  | Readonly<{
      step: "consent";
      versions: SignupAcceptance | undefined;
      problem: Problem;
      pending: PendingJoin | undefined;
    }>
  | (Carried &
      Readonly<{
        step: "contact";
        problem: Problem;
        /** A non-Saudi number was typed: the screen offers email (FR-108). */
        offerEmail: boolean;
        /** The SMS challenge the email offer replaces: sent with the email request, so it ends (FR-1812). */
        previous: string | undefined;
      }>)
  | (Carried &
      Readonly<{
        step: "code";
        contact: string;
        challengeToken: string;
        /** When the resend button wakes (ms), and, for a phone, when the email offer shows (FR-1812). */
        resendAt: number;
        emailOfferAt: number | null;
        attemptsLeft: number | null;
        problem: Problem;
      }>)
  | (Carried & Readonly<{ step: "profile"; signupToken: string; problem: Problem }>)
  | Readonly<{ step: "done"; join: PendingJoin | undefined }>
  | Readonly<{ step: "closed" }>;

export type SignInEvent =
  | Readonly<{ type: "versions_loaded"; versions: SignupAcceptance | undefined }>
  /** The terms or privacy changed since the screen loaded them (422 `acceptance_required`): ask again (T-110). */
  | Readonly<{ type: "versions_changed"; versions: SignupAcceptance | undefined; problem: Problem }>
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
  return { step: "consent", versions: undefined, problem: null, pending };
}

const pendingOf = (state: SignInState): PendingJoin | undefined =>
  state.step === "done" || state.step === "closed" ? undefined : state.pending;

const contactStep = (
  carried: Carried,
  problem: Problem,
  previous: string | undefined = undefined,
): SignInState => ({
  step: "contact",
  versions: carried.versions,
  channel: carried.channel,
  pending: carried.pending,
  problem,
  offerEmail: false,
  previous,
});

const carriedOf = (state: Carried): Carried => ({
  versions: state.versions,
  channel: state.channel,
  pending: state.pending,
});

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
      return contactStep(carriedOf(state), event.problem);
    case "new_player":
      return {
        step: "profile",
        ...carriedOf(state),
        signupToken: event.signupToken,
        problem: null,
      };
    case "channel_chosen":
      // The email offer after 30 seconds (FR-1812): the email request names this challenge so it ends.
      return contactStep(
        { ...carriedOf(state), channel: event.channel },
        null,
        state.challengeToken,
      );
    default:
      return state;
  }
}

function fromContact(
  state: Extract<SignInState, { step: "contact" }>,
  event: SignInEvent,
): SignInState {
  switch (event.type) {
    case "channel_chosen":
      return { ...state, channel: event.channel, problem: null, offerEmail: false };
    case "refused":
      return { ...state, problem: event.problem, offerEmail: event.offerEmail === true };
    case "code_sent":
      return {
        step: "code",
        ...carriedOf(state),
        contact: event.contact,
        challengeToken: event.challengeToken,
        resendAt: event.now + event.resendAfterSeconds * 1000,
        emailOfferAt:
          event.emailFallbackAfterSeconds === null
            ? null
            : event.now + event.emailFallbackAfterSeconds * 1000,
        attemptsLeft: null,
        problem: null,
      };
    default:
      return state;
  }
}

/**
 * Moves the sign-in on. Closing drops everything, the pending join included (closing sign-in joins nothing, ADR-089);
 * signing in hands the pending join on exactly once; new versions of the terms send the person back to the consent.
 */
export function signInStep(state: SignInState, event: SignInEvent): SignInState {
  if (state.step === "done" || state.step === "closed") {
    return state;
  }
  if (event.type === "closed") {
    return { step: "closed" };
  }
  if (event.type === "signed_in") {
    return { step: "done", join: pendingOf(state) };
  }
  if (event.type === "versions_changed") {
    return {
      step: "consent",
      versions: event.versions,
      problem: event.problem,
      pending: state.pending,
    };
  }
  switch (state.step) {
    case "consent":
      if (event.type === "versions_loaded") {
        return { ...state, versions: event.versions };
      }
      // No versions in force, no consent, and so no code request (T-110).
      if (event.type === "accepted" && state.versions !== undefined) {
        return contactStep(
          { versions: state.versions, channel: "phone", pending: state.pending },
          null,
        );
      }
      return state;
    case "contact":
      return fromContact(state, event);
    case "code":
      return fromCode(state, event);
    case "profile":
      if (event.type === "refused") {
        return { ...state, problem: event.problem };
      }
      // An ended signup token: back to the contact step for a new code, the pending join kept.
      return event.type === "expired" ? contactStep(carriedOf(state), event.problem) : state;
  }
}
