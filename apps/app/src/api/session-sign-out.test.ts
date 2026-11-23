import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import {
  MY_QR_KEY,
  SESSION_KEY,
  createRefresher,
  createSession,
  createSessionStore,
  type SecretStorage,
} from "#src/api/session.ts";

const headers = new Headers();
const ok = (body: unknown = {}): ApiResult => ({ kind: "ok", status: 200, body, headers });
const refused: ApiResult = {
  kind: "error",
  status: 401,
  code: "x",
  message: null,
  details: {},
  headers,
};
const issued = (n: number) => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  expiresInSeconds: 3600,
});
const ME = { method: "GET", path: "/v1/me" } as const;
const NOTHING = (): void => undefined;

/** A promise the test resolves when it chooses. */
function deferred(): { gate: Promise<void>; release: () => void } {
  let release: () => void = NOTHING;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/** Lets every pending microtask and fake answer run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A secure store that records its writes and deletes, in order. */
function recordingStorage() {
  const data = new Map<string, string>();
  const writes: string[] = [];
  const storage: SecretStorage = {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      writes.push(`set ${key}`);
      data.set(key, value);
    },
    delete: async (key) => {
      writes.push(`delete ${key}`);
      data.delete(key);
    },
  };
  return { storage, data, writes };
}

/** A fake API: answers by path, in order, and records every call's path. */
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
  return { client, calls, paths: () => calls.map((call) => call.path) };
}

const held = (gate: Promise<void>, answer: ApiResult) => async () => (await gate, answer);
const SIGN_OUT_DELETES = [`delete ${SESSION_KEY}`, `delete ${MY_QR_KEY}`];

/** Signed in with pair 1; a sign-out whose logout is held; then a request whose refresh is held. */
async function refreshDuringLogout(refreshAnswer: ApiResult) {
  const logout = deferred();
  const refresh = deferred();
  const { storage, data, writes } = recordingStorage();
  const api = fakeClient({
    "/v1/me": [refused, ok()],
    "/v1/auth/logout": [held(logout.gate, ok())],
    "/v1/auth/refresh": [held(refresh.gate, refreshAnswer)],
  });
  const session = createSession({ client: api.client, storage, now: () => 0 });
  await session.start(issued(1));
  writes.length = 0;
  let ended = 0;
  session.onEnded(() => {
    ended += 1;
  });
  const out = session.signOut();
  await flush();
  expect(api.paths()).toEqual(["/v1/auth/logout"]);
  const pending = session.request(ME);
  await flush();
  // The refresh left during the logout call, with the pair the sign-out is about to delete.
  expect(api.paths()).toEqual(["/v1/auth/logout", "/v1/me", "/v1/auth/refresh"]);
  expect(api.calls[2]?.body).toEqual({ refreshToken: "refresh-1" });
  logout.release();
  await out;
  expect(writes).toEqual(SIGN_OUT_DELETES);
  return { session, data, writes, api, pending, release: refresh.release, ended: () => ended };
}

describe("signing out while a refresh is on its way", () => {
  it("drops a refreshed pair that lands after the sign-out deleted the session", async () => {
    const f = await refreshDuringLogout(ok(issued(2)));
    f.release();
    expect(await f.pending).toEqual({ kind: "signed_out" });
    expect(f.writes).toEqual(SIGN_OUT_DELETES);
    expect(await f.session.signedIn()).toBe(false);
    expect(f.api.paths()).toEqual(["/v1/auth/logout", "/v1/me", "/v1/auth/refresh"]);
  });

  it("does not say the session ended for a refusal that lands after the sign-out finished", async () => {
    const f = await refreshDuringLogout(refused);
    f.release();
    expect(await f.pending).toEqual({ kind: "signed_out" });
    expect(f.ended()).toBe(0);
    expect(f.writes).toEqual(SIGN_OUT_DELETES);
  });

  it("leaves the next sign-in alone when the late refusal lands after it", async () => {
    const f = await refreshDuringLogout(refused);
    await f.session.start(issued(3));
    f.release();
    expect(await f.pending).toEqual({ kind: "signed_out" });
    expect(f.ended()).toBe(0);
    expect(JSON.parse(f.data.get(SESSION_KEY) ?? "null")).toMatchObject({ access: "access-3" });
  });

  it("shares one sign-out between two calls, and a refusal between them tells nobody", async () => {
    const logout = deferred();
    const refresh = deferred();
    const { storage, data } = recordingStorage();
    const api = fakeClient({
      "/v1/me": [refused],
      "/v1/auth/logout": [held(logout.gate, ok()), held(logout.gate, ok())],
      "/v1/auth/refresh": [held(refresh.gate, refused)],
    });
    const session = createSession({ client: api.client, storage, now: () => 0 });
    await session.start(issued(1));
    let ended = 0;
    session.onEnded(() => {
      ended += 1;
    });
    const first = session.signOut();
    const second = session.signOut();
    await flush();
    const pending = session.request(ME);
    await flush();
    expect(api.paths()).toEqual(["/v1/auth/logout", "/v1/me", "/v1/auth/refresh"]);
    logout.release();
    await first;
    refresh.release();
    expect(await pending).toEqual({ kind: "signed_out" });
    await second;
    expect(ended).toBe(0);
    expect(api.paths().filter((path) => path === "/v1/auth/logout")).toHaveLength(1);
    expect(api.calls[0]?.body).toEqual({ refreshToken: "refresh-1" });
    expect(data.has(SESSION_KEY)).toBe(false);
    expect(second).toBe(first);
  });

  it("clears the shared sign-out when its logout call throws, so the next sign-out sends a new one", async () => {
    const { storage, data } = recordingStorage();
    const api = fakeClient({
      "/v1/auth/logout": [
        async () => {
          throw new Error("logout failed");
        },
        ok(),
      ],
    });
    const session = createSession({ client: api.client, storage, now: () => 0 });
    await session.start(issued(1));
    const first = session.signOut();
    await expect(first).rejects.toThrow("logout failed");
    expect(data.has(SESSION_KEY)).toBe(true);
    const second = session.signOut();
    expect(second).not.toBe(first);
    await second;
    expect(api.paths()).toEqual(["/v1/auth/logout", "/v1/auth/logout"]);
    expect(api.calls[1]?.body).toEqual({ refreshToken: "refresh-1" });
    expect(data.has(SESSION_KEY)).toBe(false);
  });

  it("is an ordinary session again once the sign-out is over", async () => {
    const { storage, data } = recordingStorage();
    const api = fakeClient({
      "/v1/auth/logout": [ok()],
      "/v1/me": [refused, ok(), refused],
      "/v1/auth/refresh": [ok(issued(4)), refused],
    });
    const session = createSession({ client: api.client, storage, now: () => 0 });
    await session.start(issued(1));
    let ended = 0;
    session.onEnded(() => {
      ended += 1;
    });
    await session.signOut();
    await session.start(issued(3));
    expect(await session.request(ME)).toMatchObject({ kind: "ok" });
    expect(JSON.parse(data.get(SESSION_KEY) ?? "null")).toMatchObject({ access: "access-4" });
    expect(await session.request(ME)).toEqual({ kind: "signed_out" });
    expect(ended).toBe(1);
    expect(api.paths()).toEqual([
      "/v1/auth/logout",
      "/v1/me",
      "/v1/auth/refresh",
      "/v1/me",
      "/v1/me",
      "/v1/auth/refresh",
    ]);
  });
});

describe("createRefresher during a sign-out", () => {
  const PAIR = JSON.stringify({ access: "a-1", refresh: "r-1", expiresAt: 10 });

  function refresherWith(answer: ApiResult, signingOut: () => boolean) {
    const { storage, writes } = recordingStorage();
    void storage.set(SESSION_KEY, PAIR);
    writes.length = 0;
    const calls: string[] = [];
    const gate = deferred();
    const client: Client = {
      request: async (request) => {
        calls.push(request.path);
        await gate.gate;
        return answer;
      },
    };
    const ends: number[] = [];
    const refresher = createRefresher({
      client,
      store: createSessionStore(storage, () => 0),
      end: async () => {
        ends.push(1);
      },
      signingOut,
    });
    return { refresher, calls, writes, ends, release: gate.release };
  }

  it("still calls, but neither saves nor ends, for a refresh started during a sign-out", async () => {
    for (const answer of [ok(issued(2)), refused]) {
      const f = refresherWith(answer, () => true);
      const result = f.refresher.refresh();
      await flush();
      expect(f.calls).toEqual(["/v1/auth/refresh"]);
      f.release();
      expect(await result).toBe("ended");
      expect(f.writes).toEqual([]);
      expect(f.ends).toEqual([]);
    }
  });

  it("reads the sign-out only when the refresh starts", async () => {
    let signingOut = false;
    const f = refresherWith(ok(issued(2)), () => signingOut);
    const result = f.refresher.refresh();
    await flush();
    expect(f.calls).toEqual(["/v1/auth/refresh"]);
    signingOut = true;
    f.release();
    expect(await result).toBe("refreshed");
    expect(f.writes).toEqual([`set ${SESSION_KEY}`]);
  });
});
