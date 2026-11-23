import type { LocalizedText } from "@questify/shared";
import type { Channel } from "#src/auth/sign-in-flow.ts";

type Problem = LocalizedText | null;

/**
 * Changing or adding a phone or email (FR-125, FR-139): the new value, then the code sent to it. The account takes the
 * new value only when the code is right, so closing at any step changes nothing. Nothing here talks to the network.
 */
export type ContactState =
  | Readonly<{ step: "enter"; channel: Channel; problem: Problem }>
  | Readonly<{
      step: "code";
      channel: Channel;
      contact: string;
      challengeToken: string;
      /** When a new code may be asked for (ms): a resend is a new request, so the wait is the app's (API.md). */
      resendAt: number;
      attemptsLeft: number | null;
      problem: Problem;
    }>
  | Readonly<{ step: "done"; channel: Channel }>;

export type ContactEvent =
  | Readonly<{ type: "code_sent"; contact: string; challengeToken: string; now: number }>
  | Readonly<{ type: "refused"; problem: Problem }>
  | Readonly<{ type: "wrong_code"; attemptsLeft: number; problem: Problem }>
  /** The challenge ended (410) or another account took the value meanwhile (409): back to the entry. */
  | Readonly<{ type: "start_again"; problem: Problem }>
  | Readonly<{ type: "changed" }>;

/** The wait before another code to the same new value (the sign-in screens use the same minute). */
export const RESEND_AFTER_MS = 60_000;

export function startContact(channel: Channel): ContactState {
  return { step: "enter", channel, problem: null };
}

/** The next step for an answer. An answer that does not fit the step (a late reply) leaves it as it is. */
export function contactStep(state: ContactState, event: ContactEvent): ContactState {
  if (state.step === "done") {
    return state;
  }
  switch (event.type) {
    case "code_sent":
      return {
        step: "code",
        channel: state.channel,
        contact: event.contact,
        challengeToken: event.challengeToken,
        resendAt: event.now + RESEND_AFTER_MS,
        attemptsLeft: null,
        problem: null,
      };
    case "refused":
      return { ...state, problem: event.problem };
    case "wrong_code":
      return onCodeStep(state, (code) => ({
        ...code,
        attemptsLeft: event.attemptsLeft,
        problem: event.problem,
      }));
    case "start_again":
      return { step: "enter", channel: state.channel, problem: event.problem };
    case "changed":
      return onCodeStep(state, (code) => ({ step: "done", channel: code.channel }));
  }
}

type CodeState = Extract<ContactState, { step: "code" }>;

/** The next state from the code step; any other step (a late reply) stays as it is. */
export function onCodeStep(
  state: ContactState,
  next: (code: CodeState) => ContactState,
): ContactState {
  return state.step === "code" ? next(state) : state;
}
