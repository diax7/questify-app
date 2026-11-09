import { describe, expect, it } from "vitest";
import type { PlayerState } from "#src/auth/player-state.ts";
import {
  canWrite,
  fieldLabelKey,
  guidelinesAccepted,
  saidParts,
  showsBox,
  showsClosedNote,
} from "#src/event/submission-entry.ts";
import type { SubmissionStep } from "#src/event/submissions.ts";

const STEPS: readonly SubmissionStep[] = [
  { kind: "write" },
  { kind: "pending", points: 150 },
  ...[true, false].flatMap((again) =>
    [true, false].map(
      (system) => ({ kind: "rejected", reason: "no", again, system }) as SubmissionStep,
    ),
  ),
  { kind: "removed", reason: null },
];

const QUEST_STATES = ["open", "not_yet", "locked", "done", "not_live", "paused", "closed", "x"];

const meWith = (legal: unknown) => ({ id: "p", username: "s", legal }) as never;
const PLAYER_STATES: readonly PlayerState[] = [
  { status: "loading" },
  { status: "signed_out", ended: true },
  { status: "signed_in", me: undefined },
  { status: "signed_in", me: meWith({ toAccept: [], guidelinesAccepted: true }) },
  { status: "signed_in", me: meWith({ toAccept: [], guidelinesAccepted: false }) },
];

describe("submission entry decisions", () => {
  it("matches the inline expressions for every step and quest state", () => {
    for (const step of STEPS) {
      const oldCanWrite = step.kind === "write" || (step.kind === "rejected" && step.again);
      expect(canWrite(step)).toBe(oldCanWrite);
      expect(showsClosedNote(step)).toBe(step.kind === "rejected" && !step.again);
      expect(fieldLabelKey(step)).toBe(
        step.kind === "rejected" ? "submission.sendAgain" : "submission.label",
      );
      for (const questState of QUEST_STATES) {
        expect(showsBox(questState, step)).toBe(questState === "open" && oldCanWrite);
      }
    }
  });

  it("matches the inline acceptance check for every player state", () => {
    for (const state of PLAYER_STATES) {
      const old = state.status === "signed_in" && state.me?.legal.guidelinesAccepted === true;
      expect(guidelinesAccepted(state)).toBe(old);
    }
  });

  it("splits what a send said as the inline typeof checks did", () => {
    const words = { ar: "رفض", en: "Refused" };
    for (const said of [null, "", "Sent", words] as const) {
      expect(saidParts(said)).toEqual({
        alert: typeof said === "string" ? said : null,
        problem: typeof said === "string" ? null : said,
      });
    }
    expect(saidParts(words).problem).toBe(words);
  });
});
