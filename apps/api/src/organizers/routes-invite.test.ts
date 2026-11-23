import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";
import {
  alreadyMember,
  emailUnavailable,
  invalidRequest,
  invalidScope,
  inviteSelf,
  invitesPendingFull,
  mailCap,
  tooManyAttempts,
} from "#src/auth/http-errors";
import type { HttpError } from "#src/http-error";
import { answerInvite } from "#src/organizers/routes";
import type { InviteResult } from "#src/organizers/team";

type Seen = { status?: number; body?: unknown; headers: Record<string, string> };

const fakeReply = (seen: Seen) =>
  ({
    code(status: number) {
      seen.status = status;
      return this;
    },
    send(body: unknown) {
      seen.body = body;
      return this;
    },
    header(name: string, value: string) {
      seen.headers[name] = value;
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

const CASES: ReadonlyArray<[InviteResult, HttpError]> = [
  [{ kind: "invalid_email" }, invalidRequest()],
  [{ kind: "self" }, inviteSelf()],
  [{ kind: "already_member" }, alreadyMember()],
  [{ kind: "invalid_scope" }, invalidScope()],
  [{ kind: "mail_cap" }, mailCap()],
  [{ kind: "pending_full" }, invitesPendingFull()],
  [{ kind: "email_unavailable" }, emailUnavailable()],
];

describe("answerInvite", () => {
  it("answers 201 with the invite's id", () => {
    const seen: Seen = { headers: {} };
    answerInvite(fakeReply(seen), { kind: "invited", id: "i1" });
    expect(seen).toEqual({ status: 201, body: { id: "i1" }, headers: {} });
  });

  it.each(CASES)("throws the answer for %j and sets no header", (result, expected) => {
    const seen: Seen = { headers: {} };
    const error = thrown(() => answerInvite(fakeReply(seen), result));
    expect(error.status).toBe(expected.status);
    expect(error.envelope).toEqual(expected.envelope);
    expect(seen).toEqual({ headers: {} });
  });

  it("sets retry-after before the throttled answer", () => {
    const seen: Seen = { headers: {} };
    const error = thrown(() =>
      answerInvite(fakeReply(seen), { kind: "throttled", retryAfterSeconds: 42 }),
    );
    const expected = tooManyAttempts({ retryAfterSeconds: 42 });
    expect(error.status).toBe(429);
    expect(error.status).toBe(expected.status);
    expect(error.envelope).toEqual(expected.envelope);
    expect(seen.headers).toEqual({ "retry-after": "42" });
  });

  it("answers an invalid email with 400", () => {
    const error = thrown(() => answerInvite(fakeReply({ headers: {} }), { kind: "invalid_email" }));
    expect(error.status).toBe(400);
  });
});
