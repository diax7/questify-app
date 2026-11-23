import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";
import {
  alreadyCompleted,
  enrollmentInactive,
  idempotencyKeyReused,
  locationRefused,
  notFound,
  platformFeatureOff,
  questCodeInvalid,
  questNotOpen,
  screenCodeExpired,
  tooManyAttempts,
} from "#src/auth/http-errors";
import type { CompletionResult } from "#src/completions/complete";
import { refuseCompletion } from "#src/completions/routes";
import type { HttpError } from "#src/http-error";

type Refusal = Exclude<CompletionResult, { kind: "completed" }>;

const replyTo = (headers: Record<string, string>) =>
  ({
    header(name: string, value: string) {
      headers[name] = value;
      return this;
    },
  }) as unknown as FastifyReply;

const thrown = (run: () => unknown): HttpError => {
  try {
    run();
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("nothing was thrown");
};

const CASES: ReadonlyArray<[Refusal, HttpError, number]> = [
  [{ kind: "not_found" }, notFound(), 404],
  [
    { kind: "enrollment_inactive", reason: "banned" },
    enrollmentInactive({ reason: "banned" }),
    403,
  ],
  [{ kind: "quest_not_open", reason: "ended" }, questNotOpen({ reason: "ended" }), 403],
  [{ kind: "already_completed", cap: 3 }, alreadyCompleted({ cap: 3 }), 409],
  [{ kind: "invalid_code", problem: "expired" }, screenCodeExpired(), 422],
  [{ kind: "invalid_code", problem: "forged" }, questCodeInvalid(), 422],
  [{ kind: "invalid_code", problem: "wrong_quest" }, questCodeInvalid(), 422],
  [{ kind: "key_reused" }, idempotencyKeyReused(), 422],
  [
    { kind: "location_refused", reason: "not_here", distanceM: 120 },
    locationRefused({ reason: "not_here", distanceM: 120 }),
    422,
  ],
  [
    { kind: "location_refused", reason: "stale", distanceM: null },
    locationRefused({ reason: "stale" }),
    422,
  ],
  [{ kind: "feature_off" }, platformFeatureOff(), 403],
];

describe("refuseCompletion", () => {
  it.each(CASES)("answers %j and sets no header", (result, expected, status) => {
    const headers: Record<string, string> = {};
    const error = thrown(() => refuseCompletion(result, replyTo(headers)));
    expect(error.status).toBe(expected.status);
    expect(error.status).toBe(status);
    expect(error.envelope).toEqual(expected.envelope);
    expect(headers).toEqual({});
  });

  it("names no distance when there is none", () => {
    const error = thrown(() =>
      refuseCompletion({ kind: "location_refused", reason: "stale", distanceM: null }, replyTo({})),
    );
    expect(JSON.stringify(error.envelope)).not.toContain("distanceM");
  });

  it("sets retry-after before the rate-limit answer", () => {
    const headers: Record<string, string> = {};
    const error = thrown(() =>
      refuseCompletion({ kind: "too_many_attempts", retryAfterSeconds: 42 }, replyTo(headers)),
    );
    const expected = tooManyAttempts({ retryAfterSeconds: 42 });
    expect(error.status).toBe(429);
    expect(error.envelope).toEqual(expected.envelope);
    expect(headers).toEqual({ "retry-after": "42" });
  });
});
