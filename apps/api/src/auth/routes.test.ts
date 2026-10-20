import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerConventions } from "#src/conventions";
import { registerStaffRoutes } from "#src/auth/routes";
import type {
  ChangeResult,
  ConfirmResult,
  Passwords,
  RequestResult,
} from "#src/auth/password-reset";
import type { Sessions } from "#src/auth/session";
import type { CreateResult, SignUp, SignUpCodeResult, StartResult } from "#src/auth/sign-up";
import type { AcceptNewResult, AcceptResult, InspectResult, Invites } from "#src/organizers/accept";
import type { CodeResult, PasswordResult, ResendResult, SignIn } from "#src/auth/sign-in";
import { MemoryIdempotencyStore } from "#src/idempotency-store";

const ORIGIN = "https://app.test";
const TOKEN = "T".repeat(43);

let app: FastifyInstance;

const noSessions = {
  authenticate: async () => ({ kind: "none" }),
} as unknown as Sessions;

const ACCOUNT = { id: "u1", email: "a@x.sa", status: "active", platformRole: "none" } as const;
const liveSession = {
  authenticate: async () => ({ kind: "valid", account: ACCOUNT, sessionId: "s1" }),
} as unknown as Sessions;

async function start(results: {
  password?: PasswordResult;
  code?: CodeResult;
  resend?: ResendResult;
  request?: RequestResult;
  confirm?: ConfirmResult;
  change?: ChangeResult;
  signUpStart?: StartResult;
  signUpCode?: SignUpCodeResult;
  createOrganizer?: CreateResult;
  inspect?: InspectResult;
  accept?: AcceptResult;
  acceptNew?: AcceptNewResult;
  signedIn?: boolean;
}): Promise<void> {
  const signIn: SignIn = {
    passwordStep: async () => results.password ?? { kind: "invalid_credentials" },
    codeStep: async () => results.code ?? { kind: "challenge_expired" },
    resend: async () => results.resend ?? { kind: "challenge_expired" },
  };
  const passwords: Passwords = {
    requestReset: async () => results.request ?? { kind: "accepted" },
    confirmReset: async () => results.confirm ?? { kind: "reset" },
    change: async () => results.change ?? { kind: "changed" },
  };
  const signUp: SignUp = {
    start: async () =>
      results.signUpStart ?? { kind: "code_sent", challengeToken: TOKEN, expiresInSeconds: 600 },
    code: async () => results.signUpCode ?? { kind: "challenge_expired" },
    resend: async () => ({ kind: "resent" }),
    createOrganizer: async () => results.createOrganizer ?? { kind: "created", organizerId: "o1" },
  };
  const invites: Invites = {
    inspect: async () =>
      results.inspect ?? {
        kind: "invite",
        invite: { organizerName: "Najd", role: "editor", email: "a@x.sa", accountExists: false },
      },
    accept: async () => results.accept ?? { kind: "joined", organizerId: "o1" },
    acceptNew: async () =>
      results.acceptNew ?? { kind: "code_sent", challengeToken: TOKEN, expiresInSeconds: 600 },
  };
  app = Fastify();
  registerConventions(app, {
    minAppVersion: "1.0.0",
    idempotencyStore: new MemoryIdempotencyStore(),
  });
  registerStaffRoutes(app, {
    signIn,
    passwords,
    signUp,
    invites,
    sessions: results.signedIn === true ? liveSession : noSessions,
    dashboardOrigin: ORIGIN,
  });
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

const requestReset = (payload: unknown = { email: "a@x.sa", lang: "ar" }) =>
  post("/v1/staff/auth/reset/request", payload);
const confirmReset = () =>
  post("/v1/staff/auth/reset/confirm", { token: TOKEN, newPassword: "a long new password" });
const changePassword = () =>
  app.inject({
    method: "POST",
    url: "/v1/staff/password",
    headers: { origin: ORIGIN, cookie: `__Host-qs_session=${TOKEN}` },
    payload: { currentPassword: "old one", newPassword: "a long new password" },
  });

describe("password reset answers (T-020)", () => {
  it("accepts a request with 202 and an empty body", async () => {
    await start({});
    const response = await requestReset();
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({});
  });

  it("refuses a language other than Arabic or English, since it goes into the emailed link", async () => {
    await start({});
    expect((await requestReset({ email: "a@x.sa", lang: "fr" })).statusCode).toBe(400);
    expect((await requestReset({ email: "a@x.sa", lang: "../x" })).statusCode).toBe(400);
  });

  it("tells a throttled requester how long to wait", async () => {
    await start({ request: { kind: "throttled", retryAfterSeconds: 120 } });
    const response = await requestReset();
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("120");
    expect(response.json()).toMatchObject({ code: "too_many_attempts" });
  });

  it("answers a used reset with 204", async () => {
    await start({});
    expect((await confirmReset()).statusCode).toBe(204);
  });

  it("refuses a malformed token before calling the flow", async () => {
    await start({});
    const response = await post("/v1/staff/auth/reset/confirm", {
      token: "short",
      newPassword: "x",
    });
    expect(response.statusCode).toBe(400);
  });

  it.each([
    [{ kind: "link_invalid" } as const, 410, "reset_link_invalid", undefined],
    [{ kind: "weak", reason: "breached" } as const, 422, "weak_password", undefined],
    [{ kind: "weak", reason: "context_word" } as const, 422, "weak_password", undefined],
    [{ kind: "breach_unavailable" } as const, 503, "breach_check_unavailable", "30"],
    [{ kind: "busy" } as const, 503, "busy", "2"],
    [{ kind: "throttled", retryAfterSeconds: 5 } as const, 429, "too_many_attempts", "5"],
  ])("maps %j to %i %s", async (result, status, errorCode, retryAfter) => {
    await start({ confirm: result });
    const response = await confirmReset();
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code: errorCode });
    expect(response.headers["retry-after"]).toBe(retryAfter);
  });

  it("names the reason a password was refused", async () => {
    await start({ confirm: { kind: "weak", reason: "too_short" } });
    expect((await confirmReset()).json()).toMatchObject({ details: { reason: "too_short" } });
  });
});

describe("password change answers (T-020)", () => {
  it("needs a session", async () => {
    await start({});
    expect((await changePassword()).statusCode).toBe(401);
  });

  it("answers a change with 204", async () => {
    await start({ signedIn: true });
    expect((await changePassword()).statusCode).toBe(204);
  });

  it("answers a wrong current password with 403, not 401, so the page keeps its session", async () => {
    await start({ signedIn: true, change: { kind: "current_wrong" } });
    const response = await changePassword();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "current_password_wrong" });
  });

  it("maps a weak new password to 422 with its reason", async () => {
    await start({ signedIn: true, change: { kind: "weak", reason: "same_as_email" } });
    const response = await changePassword();
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "weak_password",
      details: { reason: "same_as_email" },
    });
  });

  it("asks to retry in 30 seconds when the breach check is down", async () => {
    await start({ signedIn: true, change: { kind: "breach_unavailable" } });
    const response = await changePassword();
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("30");
  });
});

const ACCEPT = { terms: "0.1", dpa: "0.1", contentRules: "0.1" };
const signUpStart = () =>
  post("/v1/staff/auth/sign-up", {
    email: "new@x.sa",
    password: "a long enough password",
    organizerName: "Najd Events",
    accept: ACCEPT,
  });

describe("sign-up answers (T-101)", () => {
  it("answers a started sign-up like the password step: a challenge token", async () => {
    await start({});
    const response = await signUpStart();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challengeToken: TOKEN, expiresInSeconds: 600 });
  });

  it.each([
    [{ kind: "invalid_email" } as const, 400, "invalid_request"],
    [
      { kind: "invalid_name", reason: "looks_like_address" } as const,
      422,
      "invalid_organizer_name",
    ],
    [
      { kind: "acceptance_required", documents: ["organizer_dpa"] } as const,
      422,
      "acceptance_required",
    ],
    [{ kind: "weak", reason: "breached" } as const, 422, "weak_password"],
    [{ kind: "email_unavailable" } as const, 503, "email_unavailable"],
    [{ kind: "throttled", retryAfterSeconds: 7 } as const, 429, "too_many_attempts"],
  ])("maps %j to %i %s", async (result, status, errorCode) => {
    await start({ signUpStart: result });
    const response = await signUpStart();
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code: errorCode });
  });

  it("names the refused document and the name rule", async () => {
    await start({ signUpStart: { kind: "acceptance_required", documents: ["organizer_dpa"] } });
    expect((await signUpStart()).json()).toMatchObject({
      details: { documents: ["organizer_dpa"] },
    });
    await app.close();
    await start({ signUpStart: { kind: "invalid_name", reason: "too_short" } });
    expect((await signUpStart()).json()).toMatchObject({ details: { reason: "too_short" } });
  });

  it("refuses a sign-up without the three acceptances before calling the flow", async () => {
    await start({});
    const response = await post("/v1/staff/auth/sign-up", {
      email: "new@x.sa",
      password: "a long enough password",
      organizerName: "Najd Events",
    });
    expect(response.statusCode).toBe(400);
  });

  it("opens the session cookie and names the new organizer on a right code", async () => {
    await start({
      signUpCode: {
        kind: "signed_up",
        sessionToken: TOKEN,
        account: { id: "u9", email: "new@x.sa", status: "active", platformRole: "none" },
        organizerId: "o9",
      },
    });
    const response = await post("/v1/staff/auth/sign-up/code", {
      challengeToken: TOKEN,
      code: "123456",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      account: { id: "u9", email: "new@x.sa", platformRole: "none" },
      organizerId: "o9",
    });
    expect(String(response.headers["set-cookie"])).toContain("Max-Age=43200");
  });

  it("maps a wrong code and an expired sign-up", async () => {
    await start({ signUpCode: { kind: "invalid_code", attemptsLeft: 2 } });
    const wrong = await post("/v1/staff/auth/sign-up/code", { challengeToken: TOKEN, code: "1" });
    expect(wrong.statusCode).toBe(400);
    const right = await post("/v1/staff/auth/sign-up/code", {
      challengeToken: TOKEN,
      code: "123456",
    });
    expect(right.statusCode).toBe(401);
    expect(right.json()).toMatchObject({ code: "invalid_code", details: { attemptsLeft: 2 } });
  });

  it("answers a resend with an empty object", async () => {
    await start({});
    const response = await post("/v1/staff/auth/sign-up/resend", { challengeToken: TOKEN });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });
});

const create = () =>
  app.inject({
    method: "POST",
    url: "/v1/staff/organizers",
    headers: {
      origin: ORIGIN,
      cookie: `__Host-qs_session=${TOKEN}`,
      "idempotency-key": `create-${Math.random()}`,
    },
    payload: { name: "Second Co", accept: ACCEPT },
  });

describe("creating another organizer (T-101)", () => {
  it("needs a session", async () => {
    await start({});
    expect((await create()).statusCode).toBe(401);
  });

  it("answers 201 with the new organizer", async () => {
    await start({ signedIn: true });
    const response = await create();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ organizerId: "o1" });
  });

  it.each([
    [{ kind: "invalid_name", reason: "too_long" } as const, 422, "invalid_organizer_name"],
    [
      { kind: "acceptance_required", documents: ["organizer_terms"] } as const,
      422,
      "acceptance_required",
    ],
    [{ kind: "throttled", retryAfterSeconds: 60 } as const, 429, "too_many_attempts"],
  ])("maps %j to %i %s", async (result, status, errorCode) => {
    await start({ signedIn: true, createOrganizer: result });
    const response = await create();
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code: errorCode });
  });
});

describe("invite answers (T-101)", () => {
  it("shows what an invite opens, and refuses a malformed token", async () => {
    await start({});
    const shown = await post("/v1/staff/invites/inspect", { token: TOKEN });
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({
      organizerName: "Najd",
      role: "editor",
      email: "a@x.sa",
      accountExists: false,
    });
    expect((await post("/v1/staff/invites/inspect", { token: "short" })).statusCode).toBe(400);
  });

  it.each([
    [{ kind: "invalid" } as const, 410, "invite_invalid"],
    [{ kind: "throttled", retryAfterSeconds: 9 } as const, 429, "too_many_attempts"],
  ])("maps an inspected %j to %i %s", async (result, status, errorCode) => {
    await start({ inspect: result });
    const response = await post("/v1/staff/invites/inspect", { token: TOKEN });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code: errorCode });
  });

  it("accepts for a signed-in person, and needs the session", async () => {
    const accept = () =>
      app.inject({
        method: "POST",
        url: "/v1/staff/invites/accept",
        headers: { origin: ORIGIN, cookie: `__Host-qs_session=${TOKEN}` },
        payload: { token: TOKEN },
      });
    await start({});
    expect((await accept()).statusCode).toBe(401);
    await app.close();
    await start({ signedIn: true });
    expect((await accept()).json()).toEqual({ organizerId: "o1" });
    await app.close();
    await start({ signedIn: true, accept: { kind: "other_account" } });
    const other = await accept();
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ code: "invite_other_account" });
    await app.close();
    await start({ signedIn: true, accept: { kind: "already_member" } });
    expect((await accept()).json()).toMatchObject({ code: "already_member" });
  });

  it.each([
    [{ kind: "sign_in_to_accept" } as const, 409, "sign_in_to_accept"],
    [{ kind: "invalid" } as const, 410, "invite_invalid"],
    [{ kind: "weak", reason: "breached" } as const, 422, "weak_password"],
    [{ kind: "email_unavailable" } as const, 503, "email_unavailable"],
  ])("maps a new account's acceptance %j to %i %s", async (result, status, errorCode) => {
    await start({ acceptNew: result });
    const response = await post("/v1/staff/invites/accept-new", {
      token: TOKEN,
      password: "a long enough password",
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code: errorCode });
  });

  it("chains a new account into the sign-in code step", async () => {
    await start({});
    const response = await post("/v1/staff/invites/accept-new", {
      token: TOKEN,
      password: "a long enough password",
    });
    expect(response.json()).toEqual({ challengeToken: TOKEN, expiresInSeconds: 600 });
  });
});
