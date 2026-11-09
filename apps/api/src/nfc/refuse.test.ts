import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";
import {
  abilityOff,
  enrollmentInactive,
  invalidProof,
  invalidTag,
  limitReached,
  notFound,
  notOperator,
  outsideOperatorQuests,
  platformFeatureOff,
  questNotNfc,
  questNotOpen,
  tagAlreadyRegistered,
  tagEventClosed,
  tooManyAttempts,
  unknownTag,
} from "#src/auth/http-errors";
import type { HttpError } from "#src/http-error";
import { refuseNfc } from "#src/nfc/routes";
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

/** Every NFC refusal kind, each given every field the kinds carry, so a mapper reading the wrong one shows. */
const EXTRA = { reason: "why", field: "which", limit: 7, retryAfterSeconds: 90 };
const CASES: readonly Case[] = [
  [{ kind: "unknown_tag" }, unknownTag()],
  [{ kind: "invalid_proof" }, invalidProof()],
  [{ kind: "not_operator" }, notOperator()],
  [{ kind: "ability_off" }, abilityOff()],
  [{ kind: "outside_quests" }, outsideOperatorQuests()],
  [{ kind: "event_closed" }, tagEventClosed()],
  [{ kind: "not_nfc" }, questNotNfc()],
  [{ kind: "limit_reached" }, limitReached()],
  [{ kind: "already_registered" }, tagAlreadyRegistered()],
  [{ kind: "invalid_tag", ...EXTRA }, invalidTag({ field: "which" })],
  [{ kind: "platform_off" }, platformFeatureOff()],
  [{ kind: "too_many_attempts", ...EXTRA }, tooManyAttempts({ retryAfterSeconds: 90 })],
  [{ kind: "not_found" }, notFound()],
  [{ kind: "quest_not_open", ...EXTRA }, questNotOpen({ reason: "why" })],
  [{ kind: "enrollment_inactive", ...EXTRA }, enrollmentInactive({ reason: "why" })],
];

describe("refuseNfc, one HTTP answer per refusal", () => {
  it.each(CASES)("answers %j as pinned", (input, expected) => {
    const { reply } = replyWith();
    expect(answerOf(() => refuseNfc(reply, input as never))).toEqual(describeError(expected));
  });

  it("pins the answers' own fields", () => {
    expect(invalidTag({ field: "which" }).envelope.details).toEqual({ field: "which" });
    expect(tooManyAttempts({ retryAfterSeconds: 90 }).envelope.details).toEqual({
      retryAfterSeconds: 90,
    });
    expect(describeError(unknownTag())).toMatchObject({ status: 404, code: "unknown_tag" });
  });

  it("sets Retry-After on too many attempts only, before it throws", () => {
    const { reply, headers } = replyWith();
    answerOf(() => refuseNfc(reply, { kind: "too_many_attempts", retryAfterSeconds: 90 }));
    expect(headers).toEqual([["retry-after", "90"]]);
    for (const [input] of CASES.filter(([item]) => item["kind"] !== "too_many_attempts")) {
      const other = replyWith();
      answerOf(() => refuseNfc(other.reply, input as never));
      expect(other.headers).toEqual([]);
    }
  });

  it("returns nothing for a kind it does not know, even one that names an inherited property", () => {
    for (const kind of ["nope", "constructor", "__proto__", "toString"]) {
      const { reply, headers } = replyWith();
      expect(answerOf(() => refuseNfc(reply, { kind } as never))).toBe("returned");
      expect(headers).toEqual([]);
    }
  });
});
