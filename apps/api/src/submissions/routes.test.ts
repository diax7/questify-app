import { describe, expect, it } from "vitest";
import { HttpError } from "#src/http-error";
import { refuse } from "#src/submissions/routes";
import type { SubmissionRefusal } from "#src/submissions/submissions";

const answerOf = (refusal: SubmissionRefusal) => {
  try {
    refuse(refusal);
  } catch (error) {
    if (error instanceof HttpError) {
      return [error.status, error.envelope.code, error.envelope.details];
    }
    throw error;
  }
  throw new Error("refuse returned");
};

describe("refuse (API.md, submissions)", () => {
  it.each([
    [{ kind: "not_found" }, [404, "not_found", {}]],
    [
      { kind: "enrollment_inactive", reason: "banned" },
      [403, "enrollment_inactive", { reason: "banned" }],
    ],
    [{ kind: "quest_not_open", reason: "ended" }, [403, "quest_not_open", { reason: "ended" }]],
    [{ kind: "operator_not_playing" }, [403, "operator_play_off", {}]],
    [{ kind: "not_submission_quest" }, [422, "not_submission_quest", {}]],
    [{ kind: "invalid_text", reason: "empty" }, [422, "submission_text", { reason: "empty" }]],
    [{ kind: "guidelines_required" }, [403, "guidelines_required", {}]],
    [{ kind: "pending" }, [409, "submission_pending", {}]],
    [{ kind: "closed" }, [409, "submission_closed", {}]],
    [{ kind: "already_completed" }, [409, "already_completed", {}]],
    [{ kind: "key_reused" }, [422, "idempotency_key_reused", {}]],
    [{ kind: "already_reviewed" }, [409, "already_reviewed", {}]],
    [{ kind: "not_approvable" }, [409, "not_approvable", {}]],
    [{ kind: "results_final" }, [409, "results_final", {}]],
    [{ kind: "reason_required" }, [400, "reason_required", {}]],
    [{ kind: "self_review" }, [403, "self_review", {}]],
    [{ kind: "not_operator" }, [403, "not_operator", {}]],
    [{ kind: "ability_off" }, [403, "ability_off", {}]],
    [{ kind: "outside_station" }, [403, "outside_station", {}]],
    [{ kind: "not_approved" }, [409, "not_approved", {}]],
    [{ kind: "already_removed" }, [409, "already_removed", {}]],
    [{ kind: "open_reservation" }, [409, "open_reservation", {}]],
    [{ kind: "removal_closed" }, [409, "removal_closed", {}]],
  ] as const)("answers %o", (refusal, expected) => {
    expect(answerOf(refusal as SubmissionRefusal)).toEqual(expected);
  });
});
