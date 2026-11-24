import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import { MY_QR_KEY, SESSION_KEY, createSession, type SecretStorage } from "#src/api/session.ts";

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
/** Past the pair's refresh margin: an hour-long pair with under a minute left. */
const NEAR_EXPIRY = 3600_000 - 30_000;

function deferred(): { gate: Promise<void>; release: () => void } {
  let release: () => void = NOTHING;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A secure store whose reads or deletes can start failing mid-test, the way Android's keystore can. */
function flakyStorage() {
  const data = new Map<string, string>();
  const fails = { get: false, delete: false };
  const storage: SecretStorage = {
    get: async (key) => {
      if (fails.get) {
        throw new Error("could not decrypt");
      }
      return data.get(key) ?? null;
    },
    set: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      if (fails.delete) {
        throw new Error("keystore");
      }
      data.delete(key);
    },
  };
  return { storage, data, fails };
}

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
  const tokens = () => calls.filter((c) => c.path === "/v1/me").map((c) => c.accessToken);
  return { client, calls, tokens };
}

describe("the session's secure-store items", () => {
  it("keeps the session and My QR under their released names, so an app update finds them", async () => {
    expect([SESSION_KEY, MY_QR_KEY]).toEqual(["questify.session", "questify.myQr"]);
    const { storage, data } = flakyStorage();
    data.set("questify.session", JSON.stringify({ access: "a", refresh: "r", expiresAt: 1e15 }));
    data.set("questify.myQr", "cached");
    const api = fakeClient({ "/v1/auth/logout": [ok()] });
    const session = createSession({ client: api.client, storage, now: () => 0 });
    expect(await session.signedIn()).toBe(true);
    await session.signOut();
    expect([...data.keys()]).toEqual([]);
  });

  it("signs out with a POST of the refresh token", async () => {
    const { storage } = flakyStorage();
    const api = fakeClient({ "/v1/auth/logout": [ok()] });
    const session = createSession({ client: api.client, storage, now: () => 0 });
    await session.start(issued(1));
    await session.signOut();
    expect(api.calls).toEqual([
      { method: "POST", path: "/v1/auth/logout", body: { refreshToken: "refresh-1" } },
    ]);
  });
});

describe("a refused refresh whose pair could not be deleted", () => {
  it("answers signed out before a request, and never sends the refused account's token", async () => {
    const { storage, fails } = flakyStorage();
    let clock = 0;
    const api = fakeClient({ "/v1/auth/refresh": [refused] });
    const session = createSession({ client: api.client, storage, now: () => clock });
    await session.start(issued(1));
    fails.delete = true;
    clock = NEAR_EXPIRY;
    expect(await session.request(ME)).toEqual({ kind: "signed_out" });
    expect(api.calls.map((call) => call.path)).toEqual(["/v1/auth/refresh"]);
  });

  it("answers signed out after a 401, and never retries with the refused token", async () => {
    const { storage, fails } = flakyStorage();
    const api = fakeClient({ "/v1/me": [refused, refused], "/v1/auth/refresh": [refused] });
    const session = createSession({ client: api.client, storage, now: () => 0 });
    await session.start(issued(1));
    fails.delete = true;
    expect(await session.request(ME)).toEqual({ kind: "signed_out" });
    expect(api.tokens()).toEqual(["access-1"]);
  });
});

describe("a store that stops reading during a request", () => {
  it("answers signed out when the pair cannot be read after an unreachable refresh", async () => {
    const { storage, fails } = flakyStorage();
    let clock = 0;
    const api = fakeClient({
      "/v1/auth/refresh": [
        async () => {
          fails.get = true;
          return { kind: "network" };
        },
      ],
    });
    const session = createSession({ client: api.client, storage, now: () => clock });
    await session.start(issued(1));
    clock = NEAR_EXPIRY;
    expect(await session.request(ME)).toEqual({ kind: "signed_out" });
    expect(api.tokens()).toEqual([]);
  });

  it("answers signed out when the pair cannot be read after a 401", async () => {
    const { storage, fails } = flakyStorage();
    const api = fakeClient({
      "/v1/me": [
        async () => {
          fails.get = true;
          return refused;
        },
      ],
    });
    const session = createSession({ client: api.client, storage, now: () => 0 });
    await session.start(issued(1));
    expect(await session.request(ME)).toEqual({ kind: "signed_out" });
    expect(api.calls.map((call) => call.path)).toEqual(["/v1/me"]);
  });

  it("answers signed out when the refreshed pair cannot be read back", async () => {
    const { storage, fails, data } = flakyStorage();
    const api = fakeClient({
      "/v1/me": [refused],
      "/v1/auth/refresh": [
        async () => {
          // The save still writes; only the read that follows fails.
          fails.get = true;
          return ok(issued(2));
        },
      ],
    });
    const session = createSession({ client: api.client, storage, now: () => 0 });
    await session.start(issued(1));
    expect(await session.request(ME)).toEqual({ kind: "signed_out" });
    expect(api.tokens()).toEqual(["access-1"]);
    expect(data.has(SESSION_KEY)).toBe(false);
  });
});

describe("a refresh near expiry while the player signs out (T-815)", () => {
  it("sends no request with the signed-out pair, even before the sign-out deletes it", async () => {
    const logout = deferred();
    const { storage } = flakyStorage();
    let clock = 0;
    const api = fakeClient({
      "/v1/auth/logout": [async () => (await logout.gate, ok())],
      "/v1/auth/refresh": [ok(issued(2))],
    });
    const session = createSession({ client: api.client, storage, now: () => clock });
    await session.start(issued(1));
    clock = NEAR_EXPIRY;
    const out = session.signOut();
    await flush();
    // The refresh starts during the sign-out, so its answer is dropped while the pair is still stored.
    expect(await session.request(ME)).toEqual({ kind: "signed_out" });
    expect(api.tokens()).toEqual([]);
    logout.release();
    await out;
  });

  it("tells nobody the session ended when a refresh from before the sign-out is refused during it", async () => {
    const refresh = deferred();
    const { storage, data } = flakyStorage();
    let clock = 0;
    const api = fakeClient({
      "/v1/auth/refresh": [async () => (await refresh.gate, refused)],
      "/v1/auth/logout": [ok()],
    });
    const session = createSession({ client: api.client, storage, now: () => clock });
    await session.start(issued(1));
    let ended = 0;
    session.onEnded(() => {
      ended += 1;
    });
    clock = NEAR_EXPIRY;
    const pending = session.request(ME);
    await flush();
    // The sign-out waits for this refresh, whose 401 then lands while the sign-out is under way.
    const out = session.signOut();
    await flush();
    refresh.release();
    expect(await pending).toEqual({ kind: "signed_out" });
    await out;
    expect(ended).toBe(0);
    expect(data.has(SESSION_KEY)).toBe(false);
    expect(api.calls.map((call) => call.path)).toEqual(["/v1/auth/refresh"]);
  });
});
