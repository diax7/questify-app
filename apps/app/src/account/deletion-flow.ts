import type { LocalizedText } from "@questify/shared";

type Problem = LocalizedText | null;

/** A prize still waiting for its handover (FR-128), as `POST /v1/deletion/verify` lists it. */
export type PendingPrize = Readonly<{
  redemptionId: string;
  event: Readonly<{ ar: string | null; en: string | null }>;
  item: Readonly<{ ar: string | null; en: string | null }>;
  rankPrize: boolean;
}>;

/**
 * Deleting the account (FR-126, ADR-177): what is deleted and kept, a code to the account's own contact, then the final
 * confirmation, which lists the prizes still waiting and needs the player to give them up. Nothing is deleted before
 * the last step; closing at any step changes nothing. Nothing here talks to the network.
 */
export type DeletionState =
  | Readonly<{ step: "about"; problem: Problem }>
  | Readonly<{
      step: "code";
      challengeToken: string;
      attemptsLeft: number | null;
      problem: Problem;
    }>
  | Readonly<{
      step: "confirm";
      deletionToken: string;
      pending: readonly PendingPrize[];
      forfeit: boolean;
      problem: Problem;
    }>
  | Readonly<{ step: "done" }>;

export type DeletionEvent =
  | Readonly<{ type: "code_sent"; challengeToken: string }>
  | Readonly<{ type: "refused"; problem: Problem }>
  | Readonly<{ type: "wrong_code"; attemptsLeft: number; problem: Problem }>
  /** The code or the deletion token ended (410): back to the start. */
  | Readonly<{ type: "start_again"; problem: Problem }>
  | Readonly<{ type: "verified"; deletionToken: string; pending: readonly PendingPrize[] }>
  /** A prize became pending after the code (409): list it and ask again. */
  | Readonly<{ type: "pending"; pending: readonly PendingPrize[]; problem: Problem }>
  | Readonly<{ type: "forfeit"; forfeit: boolean }>
  | Readonly<{ type: "erased" }>;

export const START: DeletionState = { step: "about", problem: null };

/** Whether the final button may be pressed: a waiting prize needs the player to give it up first. */
export function canDelete(state: DeletionState): boolean {
  return state.step === "confirm" && (state.pending.length === 0 || state.forfeit);
}

type LiveState = Exclude<DeletionState, { step: "done" }>;
type Handlers = {
  [K in DeletionEvent["type"]]: (
    state: LiveState,
    event: Extract<DeletionEvent, { type: K }>,
  ) => DeletionState;
};

const HANDLERS: Handlers = {
  code_sent: (_state, event) => ({
    step: "code",
    challengeToken: event.challengeToken,
    attemptsLeft: null,
    problem: null,
  }),
  refused: (state, event) => ({ ...state, problem: event.problem }),
  wrong_code: (state, event) =>
    state.step === "code"
      ? { ...state, attemptsLeft: event.attemptsLeft, problem: event.problem }
      : state,
  start_again: (_state, event) => ({ step: "about", problem: event.problem }),
  verified: (state, event) =>
    state.step === "code"
      ? {
          step: "confirm",
          deletionToken: event.deletionToken,
          pending: event.pending,
          forfeit: false,
          problem: null,
        }
      : state,
  pending: (state, event) =>
    state.step === "confirm"
      ? { ...state, pending: event.pending, forfeit: false, problem: event.problem }
      : state,
  forfeit: (state, event) =>
    state.step === "confirm" ? { ...state, forfeit: event.forfeit } : state,
  erased: (state) => (state.step === "confirm" ? { step: "done" } : state),
};

/** The next step for an answer. An answer that does not fit the step (a late reply) leaves it as it is. */
export function deletionStep(state: DeletionState, event: DeletionEvent): DeletionState {
  if (state.step === "done") {
    return state;
  }
  const handle = HANDLERS[event.type] as (state: LiveState, event: DeletionEvent) => DeletionState;
  return handle(state, event);
}
