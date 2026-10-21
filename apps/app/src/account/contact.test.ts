import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { ApiRequest } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import { requestContactCode, verifyContactCode } from "#src/account/contact-api.ts";
import {
  RESEND_AFTER_MS,
  contactStep,
  startContact,
  type ContactState,
} from "#src/account/contact-flow.ts";

const headers = new Headers();
const MESSAGE = { ar: "رسالة", en: "Message" };
const ok = (body: unknown): AuthedResult => ({ kind: "ok", status: 200, body, headers });
const fail = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: MESSAGE,
  details,
  headers,
});

function setup(answer: AuthedResult) {
  const calls: Omit<ApiRequest, "accessToken">[] = [];
  let keys = 0;
  const deps = {
    session: {
      request: async (request: Omit<ApiRequest, "accessToken">) => {
        calls.push(request);
        return answer;
      },
    },
    now: () => 1_000,
    newKey: () => `key-${++keys}`,
  };
  return { deps, calls };
}

const CODE: ContactState = {
  step: "code",
  channel: "email",
  contact: "sara@najd.sa",
  challengeToken: "c1",
  resendAt: 61_000,
  attemptsLeft: null,
  problem: null,
};

describe("requestContactCode", () => {
  it("asks for a code to the new value and carries the challenge", async () => {
    const { deps, calls } = setup(ok({ challengeToken: "c1", expiresInSeconds: 300 }));
    const event = await requestContactCode(deps, {
      channel: "email",
      value: "sara@najd.sa",
      lang: "ar",
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/me/contact/code",
        body: { channel: "email", value: "sara@najd.sa", lang: "ar" },
      },
    ]);
    expect(event).toEqual({
      type: "code_sent",
      contact: "sara@najd.sa",
      challengeToken: "c1",
      now: 1_000,
    });
  });

  it("shows the API's words when it refuses (already yours, not a Saudi number, too many)", async () => {
    const { deps } = setup(fail(409, "contact_unchanged"));
    expect(await requestContactCode(deps, { channel: "phone", value: "+1", lang: "en" })).toEqual({
      type: "refused",
      problem: MESSAGE,
    });
  });

  it("says the API could not be reached, and that the session ended", async () => {
    const offline = setup({ kind: "network" });
    const ended = setup({ kind: "signed_out" });
    const input = { channel: "phone", value: "0551234567", lang: "en" } as const;
    expect(await requestContactCode(offline.deps, input)).toEqual({
      type: "refused",
      problem: MESSAGES["signIn.offline"],
    });
    expect(await requestContactCode(ended.deps, input)).toEqual({
      type: "refused",
      problem: MESSAGES["signIn.sessionEnded"],
    });
  });

  it("treats an answer without a challenge as refused", async () => {
    const { deps } = setup(ok({}));
    expect(
      await requestContactCode(deps, { channel: "email", value: "a@b.sa", lang: "en" }),
    ).toEqual({ type: "refused", problem: null });
  });
});

describe("verifyContactCode", () => {
  const input = { challengeToken: "c1", code: "123456", lang: "ar" } as const;

  it("sends a new Idempotency-Key on every tap", async () => {
    const { deps, calls } = setup(ok({ id: "p" }));
    expect(await verifyContactCode(deps, input)).toEqual({ type: "changed" });
    await verifyContactCode(deps, input);
    expect(calls.map((call) => call.headers)).toEqual([
      { "idempotency-key": "key-1" },
      { "idempotency-key": "key-2" },
    ]);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/me/contact/verify", body: input });
  });

  it("reports a wrong code with the tries left", async () => {
    const { deps } = setup(fail(422, "invalid_code", { attemptsLeft: 2 }));
    expect(await verifyContactCode(deps, input)).toEqual({
      type: "wrong_code",
      attemptsLeft: 2,
      problem: MESSAGE,
    });
  });

  it("reads missing tries as none left", async () => {
    const { deps } = setup(fail(422, "invalid_code", { attemptsLeft: "2" }));
    expect(await verifyContactCode(deps, input)).toMatchObject({ attemptsLeft: 0 });
  });

  it("starts again when the code ended or another account has the value", async () => {
    for (const answer of [fail(410, "challenge_expired"), fail(409, "contact_in_use")]) {
      const { deps } = setup(answer);
      expect(await verifyContactCode(deps, input)).toEqual({
        type: "start_again",
        problem: MESSAGE,
      });
    }
  });

  it("keeps the step on any other refusal", async () => {
    const { deps } = setup(fail(409, "request_in_progress"));
    expect(await verifyContactCode(deps, input)).toEqual({ type: "refused", problem: MESSAGE });
  });
});

describe("contactStep", () => {
  it("moves to the code with the app's own resend wait", () => {
    const state = contactStep(startContact("email"), {
      type: "code_sent",
      contact: "sara@najd.sa",
      challengeToken: "c1",
      now: 1_000,
    });
    expect(state).toEqual({ ...CODE, resendAt: 1_000 + RESEND_AFTER_MS });
  });

  it("a resend replaces the challenge and clears the tries", () => {
    const state = contactStep(
      { ...CODE, attemptsLeft: 1, problem: MESSAGE },
      { type: "code_sent", contact: "sara@najd.sa", challengeToken: "c2", now: 5_000 },
    );
    expect(state).toMatchObject({ challengeToken: "c2", attemptsLeft: null, problem: null });
  });

  it("shows a refusal on the step it came from", () => {
    expect(contactStep(startContact("phone"), { type: "refused", problem: MESSAGE })).toEqual({
      step: "enter",
      channel: "phone",
      problem: MESSAGE,
    });
    expect(contactStep(CODE, { type: "refused", problem: MESSAGE })).toEqual({
      ...CODE,
      problem: MESSAGE,
    });
  });

  it("counts wrong codes only on the code step", () => {
    const wrong = { type: "wrong_code", attemptsLeft: 2, problem: MESSAGE } as const;
    expect(contactStep(CODE, wrong)).toMatchObject({ attemptsLeft: 2, problem: MESSAGE });
    expect(contactStep(startContact("email"), wrong)).toEqual(startContact("email"));
  });

  it("goes back to the entry, keeping the channel, when it must start again", () => {
    expect(contactStep(CODE, { type: "start_again", problem: MESSAGE })).toEqual({
      step: "enter",
      channel: "email",
      problem: MESSAGE,
    });
  });

  it("is done only after a right code, and stays done", () => {
    expect(contactStep(startContact("email"), { type: "changed" })).toEqual(startContact("email"));
    const done = contactStep(CODE, { type: "changed" });
    expect(done).toEqual({ step: "done", channel: "email" });
    expect(contactStep(done, { type: "refused", problem: MESSAGE })).toBe(done);
  });
});
