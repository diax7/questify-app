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

/** The next step for an answer. An answer that does not fit the step (a late reply) leaves it as it is. */
export function deletionStep(state: DeletionState, event: DeletionEvent): DeletionState {
  if (state.step === "done") {
    return state;
  }
  switch (event.type) {
    case "code_sent":
      return {
        step: "code",
        challengeToken: event.challengeToken,
        attemptsLeft: null,
        problem: null,
      };
    case "refused":
      return { ...state, problem: event.problem };
    case "wrong_code":
      return state.step === "code"
        ? { ...state, attemptsLeft: event.attemptsLeft, problem: event.problem }
        : state;
    case "start_again":
      return { step: "about", problem: event.problem };
    case "verified":
      return state.step === "code"
        ? {
            step: "confirm",
            deletionToken: event.deletionToken,
            pending: event.pending,
            forfeit: false,
            problem: null,
          }
        : state;
    case "pending":
      return state.step === "confirm"
        ? { ...state, pending: event.pending, forfeit: false, problem: event.problem }
        : state;
    case "forfeit":
      return state.step === "confirm" ? { ...state, forfeit: event.forfeit } : state;
    case "erased":
      return state.step === "confirm" ? { step: "done" } : state;
  }
}
