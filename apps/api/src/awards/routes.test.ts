import { describe, expect, it } from "vitest";
import type { AwardRefusal } from "#src/awards/awards";
import { refuse } from "#src/awards/routes";
import { HttpError } from "#src/http-error";

const answerOf = (refusal: AwardRefusal) => {
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

describe("refuse (API.md, manual awards)", () => {
  it.each([
    [{ kind: "not_found" }, [404, "not_found", {}]],
    [{ kind: "not_operator" }, [403, "not_operator", {}]],
    [{ kind: "ability_off" }, [403, "ability_off", {}]],
    [{ kind: "outside_station" }, [403, "outside_station", {}]],
    [{ kind: "self_award" }, [403, "self_award", {}]],
    [
      { kind: "enrollment_inactive", reason: "banned" },
      [403, "enrollment_inactive", { reason: "banned" }],
    ],
    [{ kind: "quest_not_open", reason: "ended" }, [403, "quest_not_open", { reason: "ended" }]],
    [{ kind: "already_completed" }, [409, "already_completed", {}]],
    [{ kind: "operator_not_playing" }, [403, "operator_play_off", {}]],
    [
      { kind: "over_cap", cap: "day", limit: 500, left: 50 },
      [409, "over_cap", { cap: "day", limit: 500, left: 50 }],
    ],
    [{ kind: "reason_required" }, [400, "reason_required", {}]],
    [{ kind: "invalid_amount" }, [400, "invalid_request", {}]],
    [{ kind: "key_reused" }, [422, "idempotency_key_reused", {}]],
    [{ kind: "already_removed" }, [409, "already_removed", {}]],
    [{ kind: "open_reservation" }, [409, "open_reservation", {}]],
    [{ kind: "not_removable" }, [422, "not_removable", {}]],
    [{ kind: "removal_closed" }, [409, "removal_closed", {}]],
    [{ kind: "too_many_lines" }, [400, "too_many_lines", {}]],
  ] as const)("answers %o", (refusal, expected) => {
    expect(answerOf(refusal as AwardRefusal)).toEqual(expected);
  });
});
