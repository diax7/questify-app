import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import type { DeviceLabel } from "#src/account/device-label.ts";
import {
  codeSentOf,
  resendCode,
  signUp,
  verifyCode,
  type CodeInput,
} from "#src/auth/sign-in-api.ts";

const headers = new Headers();
const ok = (body: unknown, status = 200): ApiResult => ({ kind: "ok", status, body, headers });
const MESSAGE = { ar: "رسالة", en: "Message" };
const fail = (status: number, code: string): ApiResult => ({
  kind: "error",
  status,
  code,
  message: MESSAGE,
  details: {},
  headers,
});
const TOKENS = { accessToken: "a", refreshToken: "r", expiresInSeconds: 3600 };
const INPUT: CodeInput = {
  channel: "phone",
  value: "+966551234567",
  lang: "ar",
  versions: { terms: "0.1", privacy: "0.1" },
};
const SIGNUP = { signupToken: "s", username: "sara", birthYear: 1995, avatar: "fox" };
const VERIFY = { challengeToken: "t", code: "123456" };

/** A fake API with one answer, a session that records what it was offered, and an optional device label. */
function setup(answer: ApiResult, device?: () => Promise<DeviceLabel | undefined>) {
  const calls: ApiRequest[] = [];
  const offered: unknown[] = [];
  const client: Client = {
    request: async (request) => {
      calls.push(request);
      return answer;
    },
  };
  const session = {
    start: async (body: unknown) => {
      offered.push(body);
      return typeof body === "object" && body !== null && "accessToken" in body;
    },
  };
  const deps = { client, session, now: () => 5_000, ...(device === undefined ? {} : { device }) };
  return { deps, calls, offered };
}

const LABEL: DeviceLabel = { platform: "android", model: "Pixel 9" };

describe("this phone's label on the sign-in steps (T-810c)", () => {
  it("sends the label with the code check and the profile step", async () => {
    const verify = setup(ok(TOKENS), async () => LABEL);
    await verifyCode(verify.deps, VERIFY);
    expect(verify.calls[0]?.body).toEqual({ ...VERIFY, device: LABEL });
    const signup = setup(ok(TOKENS, 201), async () => LABEL);
    await signUp(signup.deps, SIGNUP);
    expect(signup.calls[0]?.body).toEqual({ ...SIGNUP, device: LABEL });
  });

  it("sends no label key when the phone has none or cannot read it", async () => {
    const none = setup(ok(TOKENS), async () => undefined);
    await verifyCode(none.deps, VERIFY);
    expect(none.calls[0]?.body).toStrictEqual(VERIFY);
    const broken = setup(ok(TOKENS, 201), () => Promise.reject(new Error("no label")));
    await signUp(broken.deps, SIGNUP);
    expect(broken.calls[0]?.body).toStrictEqual(SIGNUP);
  });
});

describe("a sent code's waits", () => {
  it("reads the waits the API names, not the defaults", () => {
    const sent = ok({ challengeToken: "t", resendAfterSeconds: 45, emailFallbackAfterSeconds: 20 });
    expect(codeSentOf(sent, INPUT, () => 1)).toMatchObject({
      resendAfterSeconds: 45,
      emailFallbackAfterSeconds: 20,
    });
  });

  it("falls back to the defaults for a wait that is not a finite number", () => {
    const sent = ok({
      challengeToken: "t",
      resendAfterSeconds: Number.POSITIVE_INFINITY,
      emailFallbackAfterSeconds: "20",
    });
    expect(codeSentOf(sent, INPUT, () => 1)).toMatchObject({
      resendAfterSeconds: 60,
      emailFallbackAfterSeconds: 30,
    });
  });

  it("sends no code event, and does not throw, for a null answer body", () => {
    expect(codeSentOf(ok(null), INPUT, () => 1)).toBeUndefined();
  });
});

describe("resendCode's request and odd answers", () => {
  it("POSTs the challenge to /v1/auth/resend", async () => {
    const { deps, calls } = setup(ok({ resendAfterSeconds: 90 }, 202));
    await resendCode(deps, { challengeToken: "t", lang: "en" });
    expect(calls).toEqual([
      { method: "POST", path: "/v1/auth/resend", body: { challengeToken: "t", lang: "en" } },
    ]);
  });

  it("refuses an answer whose body is null or text, instead of restarting the wait", async () => {
    for (const body of [null, "sent"]) {
      expect(
        await resendCode(setup(ok(body, 202)).deps, { challengeToken: "t", lang: "en" }),
      ).toEqual({ type: "refused", problem: null });
    }
  });
});

describe("verifyCode and signUp with refusals", () => {
  it("offers the session nothing for a refused code or profile step", async () => {
    const verify = setup(fail(401, "invalid_code"));
    await verifyCode(verify.deps, VERIFY);
    const signup = setup(fail(422, "username_blocked"));
    await signUp(signup.deps, SIGNUP);
    expect([verify.offered, signup.offered]).toEqual([[], []]);
  });

  it("refuses a null 200 body without throwing", async () => {
    expect(await verifyCode(setup(ok(null)).deps, VERIFY)).toEqual({
      type: "refused",
      problem: null,
    });
  });

  it("refuses another 403 in the API's words; only account_banned is a ban", async () => {
    expect(await verifyCode(setup(fail(403, "forbidden")).deps, VERIFY)).toEqual({
      type: "refused",
      problem: MESSAGE,
    });
  });
});
