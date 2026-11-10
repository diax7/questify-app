import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import { createCookieSession, type RefreshLock } from "#src/api/cookie-session.ts";

const headers = new Headers();
const ok = (body: unknown = {}): ApiResult => ({ kind: "ok", status: 200, body, headers });
const fail = (status: number, code: string): ApiResult => ({
  kind: "error",
  status,
  code,
  message: null,
  details: {},
  headers,
});
const NETWORK: ApiResult = { kind: "network" };

/** A fake API: answers by path, in order, and records every call. */
function fakeClient(answers: Record<string, Array<ApiResult | (() => Promise<ApiResult>)>>) {
  const calls: ApiRequest[] = [];
  const client: Client = {
    request: async (request) => {
      calls.push(request);
      const next = answers[request.path]?.shift();
      if (next === undefined) {
        throw new Error(`No answer left for ${request.path}`);
      }
      return typeof next === "function" ? next() : next;
    },
  };
  const paths = () => calls.map((call) => call.path);
  return { client, calls, paths };
}

/**
 * The browser's cookie jar and the forwarder in one: a request is answered 200 while the cookie is current, a refresh
 * rotates it, and a stale cookie (another tab's old copy) is a 401.
 */
function cookieJar() {
  let cookie = 1;
  let accessLive = false;
  const calls: ApiRequest[] = [];
  const client: Client = {
    request: async (request) => {
      calls.push(request);
      await Promise.resolve();
      if (request.path === "/v1/auth/refresh") {
        cookie += 1;
        accessLive = true;
        return ok({ signedIn: true, expiresInSeconds: 3600 });
      }
      return accessLive ? ok({ cookie }) : fail(401, "unauthenticated");
    },
  };
  return { client, calls, refreshes: () => calls.filter((c) => c.path === "/v1/auth/refresh") };
}

const ME: ApiRequest = { method: "GET", path: "/v1/me" };
const NOTHING = (): void => undefined;

const signedIn = (answers: Record<string, ApiResult[]>) => {
  const fake = fakeClient(answers);
  return { result: createCookieSession({ client: fake.client }).signedIn(), fake };
};

describe("the web session (cookie mode)", () => {
  it("starts on `signedIn: true` only, and drops the account's own items then", async () => {
    let dropped = 0;
    const session = createCookieSession({
      client: fakeClient({}).client,
      dropAccountItems: () => {
        dropped += 1;
      },
    });
    for (const body of [
      { accessToken: "a", refreshToken: "r", expiresInSeconds: 3600 },
      { signedIn: "true" },
      { isNew: true, signupToken: "s" },
      null,
      "signedIn",
    ]) {
      expect(await session.start(body)).toBe(false);
    }
    expect(dropped).toBe(0);
    expect(await session.start({ signedIn: true, expiresInSeconds: 3600 })).toBe(true);
    expect(dropped).toBe(1);
  });

  it("never sends an access token or an authorization header", async () => {
    const { client, calls } = fakeClient({
      "/v1/me": [fail(401, "unauthenticated"), fail(401, "unauthenticated"), ok()],
      "/v1/auth/refresh": [ok({ signedIn: true })],
      "/v1/auth/logout": [ok()],
    });
    const session = createCookieSession({ client });
    await session.request(ME);
    await session.signOut();
    for (const call of calls) {
      expect(call.accessToken).toBeUndefined();
      expect(call.headers?.["authorization"]).toBeUndefined();
    }
    expect(calls.find((call) => call.path === "/v1/auth/refresh")?.body).toEqual({});
  });

  it("answers a request that is not a 401 as it came", async () => {
    const { client, paths } = fakeClient({ "/v1/me": [ok({ id: "p" })] });
    const session = createCookieSession({ client });
    expect(await session.request(ME)).toMatchObject({ kind: "ok", body: { id: "p" } });
    expect(paths()).toEqual(["/v1/me"]);
  });

  it("on a 401 retries once, then refreshes once, then sends the request again", async () => {
    const { client, paths } = fakeClient({
      "/v1/me": [fail(401, "unauthenticated"), fail(401, "unauthenticated"), ok({ id: "p" })],
      "/v1/auth/refresh": [ok({ signedIn: true })],
    });
    const session = createCookieSession({ client });
    expect(await session.request(ME)).toMatchObject({ kind: "ok", body: { id: "p" } });
    expect(paths()).toEqual(["/v1/me", "/v1/me", "/v1/auth/refresh", "/v1/me"]);
  });

  it("needs no refresh when the retry passes (another tab refreshed)", async () => {
    const { client, paths } = fakeClient({ "/v1/me": [fail(401, "unauthenticated"), ok()] });
    const session = createCookieSession({ client });
    expect(await session.request(ME)).toMatchObject({ kind: "ok" });
    expect(paths()).toEqual(["/v1/me", "/v1/me"]);
  });

  it("answers the third 401 as it is, never a loop", async () => {
    const { client, paths } = fakeClient({
      "/v1/me": [
        fail(401, "unauthenticated"),
        fail(401, "unauthenticated"),
        fail(401, "unauthenticated"),
      ],
      "/v1/auth/refresh": [ok({ signedIn: true })],
    });
    const session = createCookieSession({ client });
    expect(await session.request(ME)).toMatchObject({ kind: "error", status: 401 });
    expect(paths()).toEqual(["/v1/me", "/v1/me", "/v1/auth/refresh", "/v1/me"]);
  });

  it("gives two requests that both hit a 401 one refresh between them", async () => {
    const jar = cookieJar();
    const session = createCookieSession({ client: jar.client });
    const answers = await Promise.all([session.request(ME), session.request(ME)]);
    expect(answers.map((answer) => answer.kind)).toEqual(["ok", "ok"]);
    expect(jar.refreshes()).toHaveLength(1);
  });

  it("runs the retry and the refresh inside the lock it is given", async () => {
    const events: string[] = [];
    const lock: RefreshLock = async (task) => {
      events.push("lock");
      try {
        return await task();
      } finally {
        events.push("unlock");
      }
    };
    const jar = cookieJar();
    const client: Client = {
      request: async (request) => {
        events.push(request.path);
        return jar.client.request(request);
      },
    };
    const session = createCookieSession({ client, lock });
    await session.request(ME);
    expect(events).toEqual(["/v1/me", "lock", "/v1/me", "/v1/auth/refresh", "unlock", "/v1/me"]);
  });

  it("ends the session and tells the app only on session_expired", async () => {
    let endedCalls = 0;
    let dropped = 0;
    const expired = fakeClient({
      "/v1/me": [fail(401, "unauthenticated"), fail(401, "unauthenticated")],
      "/v1/auth/refresh": [fail(401, "session_expired")],
    });
    const session = createCookieSession({
      client: expired.client,
      dropAccountItems: () => {
        dropped += 1;
      },
    });
    session.onEnded(() => {
      endedCalls += 1;
    });
    expect(await session.request(ME)).toEqual({ kind: "signed_out" });
    expect([endedCalls, dropped]).toEqual([1, 1]);

    for (const refreshAnswer of [fail(401, "unauthenticated"), fail(503, "x"), NETWORK]) {
      let told = 0;
      const other = fakeClient({
        "/v1/me": [fail(401, "unauthenticated"), fail(401, "unauthenticated")],
        "/v1/auth/refresh": [refreshAnswer],
      });
      const quiet = createCookieSession({ client: other.client });
      quiet.onEnded(() => {
        told += 1;
      });
      expect(await quiet.request(ME)).toEqual(
        refreshAnswer.kind === "error" && refreshAnswer.status === 401
          ? { kind: "signed_out" }
          : { kind: "network" },
      );
      expect(told).toBe(0);
    }
  });

  it("tells nobody when a refresh ends while signing out", async () => {
    let told = 0;
    let releaseRefresh: () => void = NOTHING;
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const { client, paths } = fakeClient({
      "/v1/me": [fail(401, "unauthenticated"), fail(401, "unauthenticated")],
      "/v1/auth/refresh": [
        async () => {
          await gate;
          return fail(401, "session_expired");
        },
      ],
      "/v1/auth/logout": [ok()],
    });
    const session = createCookieSession({ client });
    session.onEnded(() => {
      told += 1;
    });
    const pending = session.request(ME);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const out = session.signOut();
    releaseRefresh();
    await Promise.all([pending, out]);
    expect(told).toBe(0);
    // The logout waited for the refresh in flight.
    expect(paths().slice(-2)).toEqual(["/v1/auth/refresh", "/v1/auth/logout"]);
  });

  describe("signedIn()", () => {
    const unauthorized = fail(401, "unauthenticated");

    it.each([
      ["a 200", { "/v1/me": [ok()] }, true],
      ["no network", { "/v1/me": [NETWORK] }, true],
      ["a 500", { "/v1/me": [fail(500, "x")] }, true],
      [
        "a refresh after a 401",
        {
          "/v1/me": [unauthorized, unauthorized],
          "/v1/auth/refresh": [ok({ signedIn: true })],
        },
        true,
      ],
      ["a retry that passes", { "/v1/me": [unauthorized, ok()] }, true],
      [
        "session_expired (the loader shows the session ended)",
        {
          "/v1/me": [unauthorized, unauthorized],
          "/v1/auth/refresh": [fail(401, "session_expired")],
        },
        true,
      ],
      [
        "a refresh that cannot be reached",
        { "/v1/me": [unauthorized, unauthorized], "/v1/auth/refresh": [NETWORK] },
        true,
      ],
      [
        "no cookie at all (unauthenticated)",
        { "/v1/me": [unauthorized, unauthorized], "/v1/auth/refresh": [unauthorized] },
        false,
      ],
    ])("reads %s as %s", async (_, answers, expected) => {
      const { result, fake } = signedIn(answers);
      expect(await result).toBe(expected);
      expect(fake.paths().filter((path) => path === "/v1/auth/refresh").length).toBeLessThanOrEqual(
        1,
      );
    });
  });

  it("signs out with a logout and drops My QR, even when the logout fails", async () => {
    let dropped = 0;
    const { client, calls } = fakeClient({ "/v1/auth/logout": [ok(), NETWORK] });
    const session = createCookieSession({
      client,
      dropAccountItems: () => {
        dropped += 1;
      },
    });
    await session.signOut();
    await session.signOut();
    expect(calls).toEqual([
      { method: "POST", path: "/v1/auth/logout", body: {} },
      { method: "POST", path: "/v1/auth/logout", body: {} },
    ]);
    expect(dropped).toBe(2);
  });

  it("tells the app about a legal hold", async () => {
    let holds = 0;
    const { client } = fakeClient({ "/v1/me/x": [fail(403, "legal_acceptance_required")] });
    const session = createCookieSession({ client });
    session.onLegalHold(() => {
      holds += 1;
    });
    await session.request({ method: "POST", path: "/v1/me/x", body: {} });
    expect(holds).toBe(1);
  });
});
