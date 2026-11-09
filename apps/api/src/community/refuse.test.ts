import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";
import {
  communitySettling,
  goalEventEnded,
  goalLocked,
  goalOverlap,
  goalStarted,
  invalidGoal,
  limitReached,
  notFound,
  ownerOnly,
  platformFeatureOff,
  unlockTaken,
} from "#src/auth/http-errors";
import { refuse } from "#src/community/routes";
import type { HttpError } from "#src/http-error";
import { answerOf, describeError } from "#test/support/refusal-answer";

/** A reply that records the headers set on it. */
const replyWith = () => {
  const headers: [string, string][] = [];
  const reply = {
    header: (name: string, value: string) => {
      headers.push([name, value]);
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, headers };
};

type Case = readonly [input: Record<string, unknown>, expected: HttpError];

/** Every community refusal kind, each given every field the kinds carry, so a mapper reading the wrong one shows. */
const EXTRA = { issues: ["a", "b"], field: "which", limit: 7 };
const CASES: readonly Case[] = [
  [{ kind: "not_found", ...EXTRA }, notFound()],
  [{ kind: "invalid", ...EXTRA }, invalidGoal({ issues: ["a", "b"] })],
  [{ kind: "overlap", ...EXTRA }, goalOverlap()],
  [{ kind: "unlock_taken", ...EXTRA }, unlockTaken()],
  [{ kind: "locked", ...EXTRA }, goalLocked({ field: "which" })],
  [{ kind: "started", ...EXTRA }, goalStarted()],
  [{ kind: "event_ended", ...EXTRA }, goalEventEnded()],
  [{ kind: "limit_reached", ...EXTRA }, limitReached({ limit: 7 })],
  [{ kind: "feature_off", ...EXTRA }, platformFeatureOff()],
  [{ kind: "owner_only", ...EXTRA }, ownerOnly()],
  [{ kind: "settling", ...EXTRA }, communitySettling()],
];

describe("refuse (community), one HTTP answer per refusal", () => {
  it.each(CASES)("answers %j as pinned", (input, expected) => {
    const { reply } = replyWith();
    expect(answerOf(() => refuse(reply, input as never))).toEqual(describeError(expected));
  });

  it("carries the fields each answer names", () => {
    expect(invalidGoal({ issues: ["a", "b"] }).envelope.details).toEqual({ issues: ["a", "b"] });
    expect(goalLocked({ field: "which" }).envelope.details).toEqual({ field: "which" });
    expect(limitReached({ limit: 7 }).envelope.details).toEqual({ limit: 7 });
  });

  it("sets Retry-After: 5 on settling only, before it throws", () => {
    const { reply, headers } = replyWith();
    answerOf(() => refuse(reply, { kind: "settling" }));
    expect(headers).toEqual([["retry-after", "5"]]);
    for (const [input] of CASES.filter(([item]) => item["kind"] !== "settling")) {
      const other = replyWith();
      answerOf(() => refuse(other.reply, input as never));
      expect(other.headers).toEqual([]);
    }
  });

  it("returns nothing for a kind it does not know, even one that names an inherited property", () => {
    for (const kind of ["nope", "constructor", "__proto__", "toString"]) {
      const { reply, headers } = replyWith();
      expect(answerOf(() => refuse(reply, { kind } as never))).toBe("returned");
      expect(headers).toEqual([]);
    }
  });
});
