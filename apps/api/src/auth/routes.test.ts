import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerConventions } from "#src/conventions";
import { registerStaffRoutes } from "#src/auth/routes";
import type { Sessions } from "#src/auth/session";
import type { CodeResult, PasswordResult, ResendResult, SignIn } from "#src/auth/sign-in";
import { MemoryIdempotencyStore } from "#src/idempotency-store";

const ORIGIN = "https://app.test";
const TOKEN = "T".repeat(43);

let app: FastifyInstance;

const noSessions = {
  authenticate: async () => ({ kind: "none" }),
} as unknown as Sessions;

async function start(results: {
  password?: PasswordResult;
  code?: CodeResult;
  resend?: ResendResult;
}): Promise<void> {
  const signIn: SignIn = {
    passwordStep: async () => results.password ?? { kind: "invalid_credentials" },
    codeStep: async () => results.code ?? { kind: "challenge_expired" },
    resend: async () => results.resend ?? { kind: "challenge_expired" },
  };
  app = Fastify();
  registerConventions(app, {
    minAppVersion: "1.0.0",
    idempotencyStore: new MemoryIdempotencyStore(),
  });
  registerStaffRoutes(app, { signIn, sessions: noSessions, dashboardOrigin: ORIGIN });
  await app.ready();
}

afterEach(async () => {
  await app.close();
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: { origin: ORIGIN }, payload: payload as object });

const password = () => post("/v1/staff/auth/password", { email: "a@x.sa", password: "pw" });
const code = () => post("/v1/staff/auth/code", { challengeToken: TOKEN, code: "123456" });
const resend = () => post("/v1/staff/auth/resend", { challengeToken: TOKEN });

describe("password step answers", () => {
  it.each([
    [{ kind: "code_sent", challengeToken: TOKEN, expiresInSeconds: 600 } as const, 200, undefined],
    [{ kind: "invalid_credentials" } as const, 401, "invalid_credentials"],
    [{ kind: "throttled", retryAfterSeconds: 42 } as const, 429, "too_many_attempts"],
    [{ kind: "challenge_cap", retryAfterSeconds: 77 } as const, 429, "too_many_challenges"],
    [{ kind: "busy" } as const, 503, "busy"],
    [{ kind: "email_unavailable" } as const, 503, "email_unavailable"],
  ])("maps %j to %i %s", async (result, status, errorCode) => {
    await start({ password: result });
    const response = await password();
    expect(response.statusCode).toBe(status);
    if (errorCode !== undefined) {
      expect(response.json()).toMatchObject({ code: errorCode });
    } else {
      expect(response.json()).toEqual({ challengeToken: TOKEN, expiresInSeconds: 600 });
    }
  });

  it("tells a throttled caller exactly how long to wait", async () => {
    await start({ password: { kind: "throttled", retryAfterSeconds: 42 } });
    const response = await password();
    expect(response.headers["retry-after"]).toBe("42");
    expect(response.json()).toMatchObject({ details: { retryAfterSeconds: 42 } });
  });

  it("tells a caller over the challenge cap exactly how long to wait", async () => {
    await start({ password: { kind: "challenge_cap", retryAfterSeconds: 77 } });
    const response = await password();
    expect(response.headers["retry-after"]).toBe("77");
    expect(response.json()).toMatchObject({ details: { retryAfterSeconds: 77 } });
  });

  it("asks a caller turned away because the server is busy to wait two seconds", async () => {
    await start({ password: { kind: "busy" } });
    expect((await password()).headers["retry-after"]).toBe("2");
  });
});

describe("code step answers", () => {
  const account = { id: "u1", email: "a@x.sa", status: "active" } as const;

  it("opens the cookie for the role's maximum age", async () => {
    await start({
      code: {
        kind: "signed_in",
        sessionToken: TOKEN,
        account: { ...account, platformRole: "none" },
      },
    });
    const staff = await code();
    expect(staff.statusCode).toBe(200);
    expect(staff.json()).toEqual({ account: { id: "u1", email: "a@x.sa", platformRole: "none" } });
    expect(String(staff.headers["set-cookie"])).toContain(`__Host-qs_session=${TOKEN}`);
    expect(String(staff.headers["set-cookie"])).toContain("Max-Age=43200");
    await app.close();

    await start({
      code: {
        kind: "signed_in",
        sessionToken: TOKEN,
        account: { ...account, platformRole: "admin" },
      },
    });
    expect(String((await code()).headers["set-cookie"])).toContain("Max-Age=28800");
  });

  it("says how many attempts are left", async () => {
    await start({ code: { kind: "invalid_code", attemptsLeft: 3 } });
    const response = await code();
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "invalid_code", details: { attemptsLeft: 3 } });
  });

  it("answers an expired challenge with 410", async () => {
    await start({ code: { kind: "challenge_expired" } });
    expect((await code()).statusCode).toBe(410);
  });

  it("tells a throttled caller exactly how long to wait", async () => {
    await start({ code: { kind: "throttled", retryAfterSeconds: 9 } });
    const response = await code();
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("9");
    expect(response.json()).toMatchObject({
      code: "too_many_attempts",
      details: { retryAfterSeconds: 9 },
    });
  });
});

describe("resend answers", () => {
  it("answers an accepted resend with an empty object", async () => {
    await start({ resend: { kind: "resent" } });
    const response = await resend();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it.each([
    [{ kind: "challenge_expired" } as const, 410, "challenge_expired"],
    [{ kind: "resend_limit" } as const, 429, "resend_limit"],
    [{ kind: "email_unavailable" } as const, 503, "email_unavailable"],
  ])("maps %j to %i %s", async (result, status, errorCode) => {
    await start({ resend: result });
    const response = await resend();
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code: errorCode });
  });

  it("says how long to wait before the next resend", async () => {
    await start({ resend: { kind: "resend_too_soon", retryAfterSeconds: 33 } });
    const response = await resend();
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("33");
    expect(response.json()).toMatchObject({
      code: "resend_too_soon",
      details: { retryAfterSeconds: 33 },
    });
  });
});

describe("the session guard", () => {
  it("names a missing cookie, and a cookie that is not a live session, differently", async () => {
    await start({});
    const missing = await app.inject({ method: "GET", url: "/v1/staff/me" });
    expect(missing.json()).toMatchObject({ code: "unauthenticated" });
    expect(missing.headers["set-cookie"]).toBeUndefined();

    const unknown = await app.inject({
      method: "GET",
      url: "/v1/staff/me",
      headers: { cookie: `__Host-qs_session=${TOKEN}` },
    });
    expect(unknown.json()).toMatchObject({ code: "unauthenticated" });
    expect(String(unknown.headers["set-cookie"])).toContain("Max-Age=0");
  });
});
