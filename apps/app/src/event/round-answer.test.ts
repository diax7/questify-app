import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { completionAnswer } from "#src/event/quests-api.ts";
import { roundAnswerOf } from "#src/event/games.ts";

const headers = new Headers();
const NOW = Date.parse("2030-01-01T10:00:00Z");
const ok = (body: unknown): AuthedResult => ({ kind: "ok", status: 201, body, headers });
const refused = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): AuthedResult => ({ kind: "error", status, code, message: null, details, headers });

const BODY = {
  roundId: "9",
  game: "slide_puzzle",
  level: "easy",
  seed: 7,
  params: { size: 3 },
  engineVersion: 1,
  deadlineAt: "2030-01-01T10:13:00Z",
  serverNow: "2030-01-01T10:00:00Z",
};

describe("roundAnswerOf, field by field", () => {
  it("needs every field, and reads a missing level as the text of undefined", () => {
    expect(roundAnswerOf(ok(BODY), "q1", NOW)).toMatchObject({ kind: "round" });
    for (const field of ["roundId", "game", "seed", "engineVersion", "deadlineAt", "serverNow"]) {
      expect(roundAnswerOf(ok({ ...BODY, [field]: undefined }), "q1", NOW), field).toEqual({
        kind: "failed",
      });
    }
    expect(roundAnswerOf(ok({ ...BODY, game: "chess" }), "q1", NOW)).toEqual({ kind: "failed" });
    expect(roundAnswerOf(ok({ ...BODY, seed: "7" }), "q1", NOW)).toEqual({ kind: "failed" });
    expect(roundAnswerOf(ok(null), "q1", NOW)).toEqual({ kind: "failed" });
    expect(roundAnswerOf(ok("round"), "q1", NOW)).toEqual({ kind: "failed" });
    expect(roundAnswerOf(ok({ ...BODY, level: undefined }), "q1", NOW)).toMatchObject({
      kind: "round",
      round: { questId: "q1", level: "undefined", params: { size: 3 }, seed: 7 },
    });
  });

  it("reads a refusal without a retry time or reason, and hands other errors to the quest's words", () => {
    expect(roundAnswerOf(refused(409, "game_refused"), "q1", NOW)).toEqual({
      kind: "game_refused",
      reason: "undefined",
      retryAt: null,
    });
    expect(
      roundAnswerOf(refused(409, "game_refused", { reason: "no_attempts", retryAt: 5 }), "q1", NOW),
    ).toEqual({ kind: "game_refused", reason: "no_attempts", retryAt: null });
    expect(roundAnswerOf(refused(500, "internal"), "q1", NOW)).toEqual(
      completionAnswer(refused(500, "internal")),
    );
    expect(roundAnswerOf(refused(404, "not_found"), "q1", NOW)).toEqual(
      completionAnswer(refused(404, "not_found")),
    );
    expect(roundAnswerOf({ kind: "signed_out" }, "q1", NOW)).toEqual({ kind: "signed_out" });
    expect(roundAnswerOf({ kind: "network" }, "q1", NOW)).toEqual({ kind: "network" });
  });
});
