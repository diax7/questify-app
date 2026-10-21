import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import type { Issued } from "#src/api/session.ts";
import { requestCode, resendCode, signUp, verifyCode } from "#src/auth/sign-in-api.ts";

const headers = new Headers();
const ok = (body: unknown, status = 200): ApiResult => ({ kind: "ok", status, body, headers });
const MESSAGE = { ar: "رسالة", en: "Message" };
const fail = (status: number, code: string, details: Record<string, unknown> = {}): ApiResult => ({
  kind: "error",
  status,
  code,
  message: MESSAGE,
  details,
  headers,
});
const TOKENS = { accessToken: "a", refreshToken: "r", expiresInSeconds: 3600, player: { id: "p" } };

function setup(answer: ApiResult) {
  const calls: ApiRequest[] = [];
  const started: Issued[] = [];
  const client: Client = {
    request: async (request) => {
      calls.push(request);
      return answer;
    },
  };
  const deps = {
    client,
    session: { start: async (issued: Issued) => void started.push(issued) },
    now: () => 5_000,
  };
  return { deps, calls, started };
}

const VERSIONS = { terms: "0.1", privacy: "0.1" };

describe("requestCode", () => {
  it("sends the contact with the accepted versions and reads the times", async () => {
    const { deps, calls } = setup(
      ok({ challengeToken: "t", resendAfterSeconds: 60, emailFallbackAfterSeconds: 30 }, 202),
    );
    expect(
      await requestCode(deps, {
        channel: "phone",
        value: "0551234567",
        lang: "ar",
        versions: VERSIONS,
      }),
    ).toEqual({
      type: "code_sent",
      contact: "0551234567",
      challengeToken: "t",
      now: 5_000,
      resendAfterSeconds: 60,
      emailFallbackAfterSeconds: 30,
    });
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/v1/auth/code",
      body: { channel: "phone", value: "0551234567", lang: "ar", accept: VERSIONS },
    });
  });

  it("passes the earlier challenge when switching to email, with no email offer for email", async () => {
    const { deps, calls } = setup(ok({ challengeToken: "t2" }, 202));
    const event = await requestCode(deps, {
      channel: "email",
      value: "a@b.sa",
      lang: "en",
      versions: VERSIONS,
      previous: "t1",
    });
    expect(event).toMatchObject({
      type: "code_sent",
      resendAfterSeconds: 60,
      emailFallbackAfterSeconds: null,
    });
    expect(calls[0]?.body).toMatchObject({ previous: "t1" });
  });

  it("refuses with the API's message, offering email when it says so", async () => {
    expect(
      await requestCode(setup(fail(422, "phone_not_supported", { emailOffered: true })).deps, {
        channel: "phone",
        value: "+1 415",
        lang: "en",
        versions: VERSIONS,
      }),
    ).toEqual({ type: "refused", problem: MESSAGE, offerEmail: true });
    expect(
      await requestCode(setup({ kind: "network" }).deps, {
        channel: "phone",
        value: "x",
        lang: "en",
        versions: VERSIONS,
      }),
    ).toMatchObject({
      type: "refused",
      problem: { en: expect.stringContaining("could not be reached") },
      offerEmail: false,
    });
    expect(
      await requestCode(setup(ok({ wrong: true })).deps, {
        channel: "phone",
        value: "x",
        lang: "en",
        versions: VERSIONS,
      }),
    ).toEqual({ type: "refused", problem: null, offerEmail: false });
  });
});

describe("resendCode", () => {
  it("restarts the wait, ends on an expired challenge, refuses otherwise", async () => {
    expect(
      await resendCode(setup(ok({ resendAfterSeconds: 90 }, 202)).deps, {
        challengeToken: "t",
        lang: "ar",
      }),
    ).toEqual({
      type: "resent",
      now: 5_000,
      resendAfterSeconds: 90,
    });
    expect(
      await resendCode(setup(fail(410, "challenge_expired")).deps, {
        challengeToken: "t",
        lang: "ar",
      }),
    ).toEqual({
      type: "expired",
      problem: MESSAGE,
    });
    expect(
      await resendCode(setup(fail(429, "resend_too_soon")).deps, {
        challengeToken: "t",
        lang: "ar",
      }),
    ).toEqual({
      type: "refused",
      problem: MESSAGE,
    });
  });
});

describe("verifyCode", () => {
  it("keeps a returning player's tokens and signs them in", async () => {
    const { deps, started, calls } = setup(ok(TOKENS));
    expect(await verifyCode(deps, { challengeToken: "t", code: "123456" })).toEqual({
      type: "signed_in",
    });
    expect(started).toEqual([TOKENS]);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/v1/auth/verify",
      body: { challengeToken: "t", code: "123456" },
    });
  });

  it("takes a new contact to the profile step", async () => {
    const { deps, started } = setup(ok({ isNew: true, signupToken: "s" }));
    expect(await verifyCode(deps, { challengeToken: "t", code: "1" })).toEqual({
      type: "new_player",
      signupToken: "s",
    });
    expect(started).toEqual([]);
  });

  it("counts a wrong code, ends an expired one, refuses a banned account", async () => {
    expect(
      await verifyCode(setup(fail(401, "invalid_code", { attemptsLeft: 1 })).deps, {
        challengeToken: "t",
        code: "1",
      }),
    ).toEqual({ type: "wrong_code", attemptsLeft: 1, problem: MESSAGE });
    expect(
      await verifyCode(setup(fail(401, "invalid_code")).deps, { challengeToken: "t", code: "1" }),
    ).toMatchObject({
      attemptsLeft: 0,
    });
    expect(
      await verifyCode(setup(fail(410, "challenge_expired")).deps, {
        challengeToken: "t",
        code: "1",
      }),
    ).toEqual({
      type: "expired",
      problem: MESSAGE,
    });
    expect(
      await verifyCode(setup(fail(403, "account_banned")).deps, { challengeToken: "t", code: "1" }),
    ).toEqual({
      type: "refused",
      problem: MESSAGE,
    });
  });
});

describe("signUp", () => {
  it("signs a new player in, or says why not", async () => {
    const { deps, started, calls } = setup(ok(TOKENS, 201));
    const input = { signupToken: "s", username: "sara", birthYear: 1995, avatar: "fox" };
    expect(await signUp(deps, input)).toEqual({ type: "signed_in" });
    expect(started).toEqual([TOKENS]);
    expect(calls[0]).toEqual({ method: "POST", path: "/v1/auth/signup", body: input });
    expect(await signUp(setup(fail(422, "username_blocked")).deps, input)).toEqual({
      type: "refused",
      problem: MESSAGE,
    });
    expect(await signUp(setup(fail(410, "signup_expired")).deps, input)).toEqual({
      type: "expired",
      problem: MESSAGE,
    });
  });
});
