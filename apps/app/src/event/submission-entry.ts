import type { LocalizedText, MessageKey } from "@questify/shared";
import type { PlayerState } from "#src/auth/player-state.ts";
import type { SubmissionStep } from "#src/event/submissions.ts";

/** Whether the box shows: nothing sent yet, or a rejection the quest lets the player answer again. */
export const canWrite = (step: SubmissionStep): boolean =>
  step.kind === "write" || (step.kind === "rejected" && step.again);

/** Whether the signed-in player has accepted the community guidelines in force. */
export const guidelinesAccepted = (state: PlayerState): boolean =>
  state.status === "signed_in" && state.me?.legal.guidelinesAccepted === true;

/** The box shows only while the quest is open and the latest submission leaves room for another. */
export const showsBox = (questState: string, step: SubmissionStep): boolean =>
  questState === "open" && canWrite(step);

/** A rejection the quest does not let the player answer again says so. */
export const showsClosedNote = (step: SubmissionStep): boolean =>
  step.kind === "rejected" && !step.again;

/** The box is labelled "send again" after a rejection. */
export const fieldLabelKey = (step: SubmissionStep): MessageKey =>
  step.kind === "rejected" ? "submission.sendAgain" : "submission.label";

/** What a send said, split into the line read out as an alert and the API's own problem words. */
export function saidParts(said: string | LocalizedText | null): Readonly<{
  alert: string | null;
  problem: LocalizedText | null;
}> {
  return {
    alert: typeof said === "string" ? said : null,
    problem: typeof said === "string" ? null : said,
  };
}
