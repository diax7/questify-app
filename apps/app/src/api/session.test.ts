import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import { MY_QR_KEY, SESSION_KEY, createSession, type SecretStorage } from "#src/api/session.ts";

const headers = new Headers();
const ok = (body: unknown = {}): ApiResult => ({ kind: "ok", status: 200, body, headers });
const fail = (status: number, code = "x"): ApiResult => ({
  kind: "error",
  status,
  code,
  message: null,
  details: {},
  headers,
});

function memoryStorage(): SecretStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
  };
}

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
  return { client, calls };
}

const NOTHING = (): void => undefined;

/** A promise the test resolves when it chooses, to hold a refresh in flight. */
function deferred(): { gate: Promise<void>; release: () => void } {
  let release: () => void = NOTHING;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/** A secure store that fails the way Android's keystore can. */
const failing = (fails: Partial<Record<"get" | "set" | "delete", boolean>>) => {
  const storage = memoryStorage();
  const deletes: string[] = [];
  return {
    storage,
    deletes,
    failing: {
      get: async (key: string) => {
        if (fails.get === true) {
          throw new Error("could not decrypt");
        }
        return storage.get(key);
      },
      set: async (key: string, value: string) => {
        if (fails.set === true) {
          throw new Error("keystore");
        }
        return storage.set(key, value);
      },
      delete: async (key: string) => {
        deletes.push(key);
        if (fails.delete === true) {
          throw new Error("keystore");
        }
        return storage.delete(key);
      },
    },
  };
};

const issued = (n: number) => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  expiresInSeconds: 3600,
});

describe("the session", () => {
  it("keeps the tokens as one item and uses the access token", async () => {
    const storage = memoryStorage();
    const { client, calls } = fakeClient({ "/v1/me": [ok({ id: "p" })] });
    const session = createSession({ client, storage, now: () => 1_000 });
    expect(await session.signedIn()).toBe(false);
    await session.start(issued(1));
    expect(JSON.parse(storage.data.get(SESSION_KEY) ?? "")).toEqual({
      access: "access-1",
      refresh: "refresh-1",
      expiresAt: 1_000 + 3_600_000,
    });
    expect(await session.signedIn()).toBe(true);
    expect(await session.request({ method: "GET", path: "/v1/me" })).toMatchObject({ kind: "ok" });
    expect(calls[0]?.accessToken).toBe("access-1");
  });

  it("refreshes before a request when under a minute is left", async () => {
    let time = 0;
    const storage = memoryStorage();
    const { client, calls } = fakeClient({
      "/v1/auth/refresh": [ok(issued(2))],
      "/v1/me": [ok()],
    });
    const session = createSession({ client, storage, now: () => time });
    await session.start(issued(1));
    time = 3_600_000 - 59_000;
    await session.request({ method: "GET", path: "/v1/me" });
    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/refresh", "/v1/me"]);
    expect(calls[0]?.body).toEqual({ refreshToken: "refresh-1" });
    expect(calls[1]?.accessToken).toBe("access-2");
  });

  it("does not refresh with more than a minute left", async () => {
    let time = 0;
    const { client, calls } = fakeClient({ "/v1/me": [ok()] });
    const session = createSession({ client, storage: memoryStorage(), now: () => time });
    await session.start(issued(1));
    time = 3_600_000 - 61_000;
    await session.request({ method: "GET", path: "/v1/me" });
    expect(calls.map((call) => call.path)).toEqual(["/v1/me"]);
  });

  it("sends one refresh for many requests that meet a 401 at once", async () => {
    const { gate, release } = deferred();
    const { client, calls } = fakeClient({
      "/v1/me": [fail(401), fail(401), fail(401), ok(), ok(), ok()],
      "/v1/auth/refresh": [async () => (await gate, ok(issued(2)))],
    });
    const session = createSession({ client, storage: memoryStorage(), now: () => 0 });
    await session.start(issued(1));
    const all = Promise.all(
      [1, 2, 3].map(() => session.request({ method: "GET", path: "/v1/me" })),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    expect((await all).map((result) => result.kind)).toEqual(["ok", "ok", "ok"]);
    expect(calls.filter((call) => call.path === "/v1/auth/refresh")).toHaveLength(1);
    expect(
      calls
        .filter((call) => call.path === "/v1/me")
        .slice(3)
        .map((call) => call.accessToken),
    ).toEqual(["access-2", "access-2", "access-2"]);
  });

  it("retries a 401 once only: a second 401 is the answer", async () => {
    const { client, calls } = fakeClient({
      "/v1/me": [fail(401), fail(401)],
      "/v1/auth/refresh": [ok(issued(2))],
    });
    const session = createSession({ client, storage: memoryStorage(), now: () => 0 });
    await session.start(issued(1));
    expect(await session.request({ method: "GET", path: "/v1/me" })).toMatchObject({ status: 401 });
    expect(calls.map((call) => call.path)).toEqual(["/v1/me", "/v1/auth/refresh", "/v1/me"]);
  });

  it("ends the session only on a 401 from the refresh, and tells the app", async () => {
    const storage = memoryStorage();
    const { client } = fakeClient({ "/v1/me": [fail(401)], "/v1/auth/refresh": [fail(401)] });
    const session = createSession({ client, storage, now: () => 0 });
    await session.start(issued(1));
    let ended = 0;
    session.onEnded(() => {
      ended += 1;
    });
    expect(await session.request({ method: "GET", path: "/v1/me" })).toEqual({
      kind: "signed_out",
    });
    expect(ended).toBe(1);
    expect(storage.data.has(SESSION_KEY)).toBe(false);
    expect(await session.request({ method: "GET", path: "/v1/me" })).toEqual({
      kind: "signed_out",
    });
  });

  it("keeps the tokens when the refresh cannot reach the API, a 5xx or a 429, and tries the same token again", async () => {
    for (const refused of [{ kind: "network" } as const, fail(503), fail(429)]) {
      const storage = memoryStorage();
      const { client, calls } = fakeClient({
        "/v1/me": [fail(401), fail(401), ok()],
        "/v1/auth/refresh": [refused, ok(issued(2))],
      });
      const session = createSession({ client, storage, now: () => 0 });
      await session.start(issued(1));
      let ended = 0;
      session.onEnded(() => {
        ended += 1;
      });
      // The screen says "can't reach Questify", not the API's "sign in again": the session is kept.
      expect(await session.request({ method: "GET", path: "/v1/me" })).toEqual({ kind: "network" });
      expect(ended).toBe(0);
      expect(JSON.parse(storage.data.get(SESSION_KEY) ?? "").refresh).toBe("refresh-1");
      await session.request({ method: "GET", path: "/v1/me" });
      const refreshes = calls.filter((call) => call.path === "/v1/auth/refresh");
      expect(refreshes.map((call) => call.body)).toEqual([
        { refreshToken: "refresh-1" },
        { refreshToken: "refresh-1" },
      ]);
    }
  });

  it("ignores a refresh answer of the wrong shape, keeping the tokens", async () => {
    const storage = memoryStorage();
    const { client } = fakeClient({
      "/v1/me": [fail(401)],
      "/v1/auth/refresh": [ok({ accessToken: 1 })],
    });
    const session = createSession({ client, storage, now: () => 0 });
    await session.start(issued(1));
    await session.request({ method: "GET", path: "/v1/me" });
    expect(JSON.parse(storage.data.get(SESSION_KEY) ?? "").access).toBe("access-1");
  });

  it("is signed out without tokens, or with a stored item it cannot read", async () => {
    const storage = memoryStorage();
    const { client, calls } = fakeClient({});
    const session = createSession({ client, storage });
    expect(await session.request({ method: "GET", path: "/v1/me" })).toEqual({
      kind: "signed_out",
    });
    for (const broken of ["not json", JSON.stringify({ access: "a" }), "null"]) {
      storage.data.set(SESSION_KEY, broken);
      expect(await session.signedIn()).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("signs out with the newest refresh token, after a refresh in flight, and clears even when the call fails", async () => {
    const { gate, release } = deferred();
    const storage = memoryStorage();
    const { client, calls } = fakeClient({
      "/v1/me": [fail(401), ok()],
      "/v1/auth/refresh": [async () => (await gate, ok(issued(2)))],
      "/v1/auth/logout": [{ kind: "network" }],
    });
    const session = createSession({ client, storage, now: () => 0 });
    await session.start(issued(1));
    const pending = session.request({ method: "GET", path: "/v1/me" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const out = session.signOut();
    release();
    await Promise.all([pending, out]);
    expect(calls.find((call) => call.path === "/v1/auth/logout")?.body).toEqual({
      refreshToken: "refresh-2",
    });
    expect(storage.data.has(SESSION_KEY)).toBe(false);
  });

  it("stops telling a listener once it unsubscribes", async () => {
    const { client } = fakeClient({ "/v1/me": [fail(401)], "/v1/auth/refresh": [fail(401)] });
    const session = createSession({ client, storage: memoryStorage(), now: () => 0 });
    await session.start(issued(1));
    let ended = 0;
    const stop = session.onEnded(() => {
      ended += 1;
    });
    stop();
    await session.request({ method: "GET", path: "/v1/me" });
    expect(ended).toBe(0);
  });

  it("refreshes at exactly one minute left, with a POST of the refresh token", async () => {
    let time = 0;
    const { client, calls } = fakeClient({ "/v1/auth/refresh": [ok(issued(2))], "/v1/me": [ok()] });
    const session = createSession({ client, storage: memoryStorage(), now: () => time });
    await session.start(issued(1));
    time = 3_600_000 - 60_000;
    await session.request({ method: "GET", path: "/v1/me" });
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/v1/auth/refresh",
      body: { refreshToken: "refresh-1" },
    });
  });

  it("reads a stored item only when every field has its type", async () => {
    const storage = memoryStorage();
    const session = createSession({ client: fakeClient({}).client, storage });
    for (const broken of [
      { refresh: "r", expiresAt: 1 },
      { access: "a", expiresAt: 1 },
      { access: "a", refresh: "r" },
      { access: 1, refresh: "r", expiresAt: 1 },
      { access: "a", refresh: 2, expiresAt: 1 },
      { access: "a", refresh: "r", expiresAt: "1" },
      7,
    ]) {
      storage.data.set(SESSION_KEY, JSON.stringify(broken));
      expect(await session.signedIn(), JSON.stringify(broken)).toBe(false);
    }
    storage.data.set(SESSION_KEY, JSON.stringify({ access: "a", refresh: "r", expiresAt: 1 }));
    expect(await session.signedIn()).toBe(true);
  });

  it("keeps the old tokens when the refresh answer lacks any field", async () => {
    for (const body of [
      { refreshToken: "r", expiresInSeconds: 1 },
      { accessToken: "a", expiresInSeconds: 1 },
      { accessToken: "a", refreshToken: "r" },
      { accessToken: "a", refreshToken: "r", expiresInSeconds: "1" },
      null,
      "tokens",
    ]) {
      const storage = memoryStorage();
      const { client } = fakeClient({ "/v1/me": [fail(401)], "/v1/auth/refresh": [ok(body)] });
      const session = createSession({ client, storage, now: () => 0 });
      await session.start(issued(1));
      await session.request({ method: "GET", path: "/v1/me" });
      expect(JSON.parse(storage.data.get(SESSION_KEY) ?? "").refresh, JSON.stringify(body)).toBe(
        "refresh-1",
      );
    }
  });

  it("ends a refresh that finds no tokens without asking the API", async () => {
    let reads = 0;
    const storage = memoryStorage();
    const pair = JSON.stringify({ access: "a", refresh: "r", expiresAt: 10 });
    const vanishing: typeof storage = {
      ...storage,
      // The first read sees an expiring pair; by the refresh it has gone (signed out elsewhere).
      get: async () => (reads++ === 0 ? pair : null),
    };
    const { client, calls } = fakeClient({});
    const session = createSession({ client, storage: vanishing, now: () => 0 });
    expect(await session.request({ method: "GET", path: "/v1/me" })).toEqual({
      kind: "signed_out",
    });
    expect(calls).toEqual([]);
  });

  it("drops the cached My QR with the account: at sign-out and at the next sign-in", async () => {
    const { client } = fakeClient({ "/v1/auth/logout": [ok()] });
    const storage = memoryStorage();
    const session = createSession({ client, storage, now: () => 0 });
    await storage.set(MY_QR_KEY, "earlier account");
    await session.start(issued(1));
    expect(storage.data.has(MY_QR_KEY)).toBe(false);
    await storage.set(MY_QR_KEY, "this account");
    await session.signOut();
    expect(storage.data.has(MY_QR_KEY)).toBe(false);
  });

  it("signs out with no call when nothing is stored", async () => {
    const { client, calls } = fakeClient({});
    const storage = memoryStorage();
    await createSession({ client, storage }).signOut();
    expect(calls).toEqual([]);
  });

  it("answers network, not the 401, when the refresh could not be done but the tokens remain", async () => {
    const storage = memoryStorage();
    const { client } = fakeClient({
      "/v1/me": [fail(401, "session_expired")],
      "/v1/auth/refresh": [fail(503)],
    });
    const session = createSession({ client, storage, now: () => 0 });
    await session.start(issued(1));
    expect(await session.request({ method: "GET", path: "/v1/me" })).toEqual({ kind: "network" });
    expect(await session.signedIn()).toBe(true);
  });

  describe("a failing secure store", () => {
    it("treats a store it cannot read as no session, and deletes the item", async () => {
      const { failing: store, deletes } = failing({ get: true });
      const { client, calls } = fakeClient({});
      const session = createSession({ client, storage: store });
      expect(await session.signedIn()).toBe(false);
      expect(await session.request({ method: "GET", path: "/v1/me" })).toEqual({
        kind: "signed_out",
      });
      await session.signOut();
      expect(deletes).toContain(SESSION_KEY);
      expect(calls).toEqual([]);
    });

    it("keeps the old pair when the new one cannot be written, and answers network", async () => {
      const { storage, failing: store } = failing({});
      const { client } = fakeClient({ "/v1/me": [fail(401)], "/v1/auth/refresh": [ok(issued(2))] });
      const session = createSession({ client, storage: store, now: () => 0 });
      await session.start(issued(1));
      store.set = async () => {
        throw new Error("keystore");
      };
      expect(await session.request({ method: "GET", path: "/v1/me" })).toEqual({ kind: "network" });
      expect(JSON.parse(storage.data.get(SESSION_KEY) ?? "").refresh).toBe("refresh-1");
    });

    it("signs out even when the store cannot delete", async () => {
      const { storage, failing: store } = failing({ delete: true });
      const { client, calls } = fakeClient({ "/v1/auth/logout": [ok()] });
      const session = createSession({ client, storage: store });
      await storage.set(
        SESSION_KEY,
        JSON.stringify({ access: "a", refresh: "r", expiresAt: 1e15 }),
      );
      await expect(session.signOut()).resolves.toBeUndefined();
      expect(calls.map((call) => call.path)).toEqual(["/v1/auth/logout"]);
    });
  });

  it("uses a token another request already renewed instead of refreshing again", async () => {
    const storage = memoryStorage();
    const { client, calls } = fakeClient({ "/v1/me": [fail(401), ok()] });
    const session = createSession({ client, storage, now: () => 0 });
    await session.start(issued(1));
    const late = client.request;
    // While this request waits, another one finished a refresh: the store now holds access-2.
    let swapped = false;
    const wrapped = {
      request: async (request: Parameters<typeof late>[0]) => {
        const answer = await late(request);
        if (!swapped) {
          swapped = true;
          await session.start(issued(2));
        }
        return answer;
      },
    };
    const racing = createSession({ client: wrapped, storage, now: () => 0 });
    expect(await racing.request({ method: "GET", path: "/v1/me" })).toMatchObject({ kind: "ok" });
    expect(calls.map((call) => [call.path, call.accessToken])).toEqual([
      ["/v1/me", "access-1"],
      ["/v1/me", "access-2"],
    ]);
  });

  it("does not say the session ended when the player chose to sign out", async () => {
    const request401 = deferred();
    const logoutDone = deferred();
    const storage = memoryStorage();
    const { client, calls } = fakeClient({
      "/v1/me": [async () => (await request401.gate, fail(401))],
      "/v1/auth/logout": [async () => (await logoutDone.gate, ok())],
      "/v1/auth/refresh": [fail(401)],
    });
    const session = createSession({ client, storage, now: () => 0 });
    await session.start(issued(1));
    let ended = 0;
    session.onEnded(() => {
      ended += 1;
    });
    const pending = session.request({ method: "GET", path: "/v1/me" });
    const out = session.signOut();
    // The logout is on its way; the earlier request now meets a 401 and its refresh is refused.
    await new Promise((resolve) => setTimeout(resolve, 10));
    request401.release();
    expect(await pending).toEqual({ kind: "signed_out" });
    logoutDone.release();
    await out;
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/me",
      "/v1/auth/logout",
      "/v1/auth/refresh",
    ]);
    expect(ended).toBe(0);
    // Once the sign-out is over, a session that ends on its own is told again.
    await session.start(issued(3));
    const later = fakeClient({ "/v1/me": [fail(401)], "/v1/auth/refresh": [fail(401)] });
    const again = createSession({ client: later.client, storage, now: () => 0 });
    again.onEnded(() => {
      ended += 1;
    });
    await again.request({ method: "GET", path: "/v1/me" });
    expect(ended).toBe(1);
  });
});
