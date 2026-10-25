import { describe, expect, it, vi } from "vitest";
import type { ApiResult, Client } from "#src/api/client.ts";
import { createSession, type SecretStorage } from "#src/api/session.ts";
import { createPlayerLoader, type PlayerState } from "#src/auth/player-state.ts";

const ok = (body: unknown = {}): ApiResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(),
});
const failed = (status: number): ApiResult => ({
  kind: "error",
  status,
  code: "failed",
  message: null,
  details: {},
  headers: new Headers(),
});
const profile = (id: string) => ({
  id,
  username: id,
  avatar: "falcon",
  legal: { toAccept: [], guidelinesAccepted: true },
  identifiers: { phone: null, email: `${id}@masked` },
  equipment: {
    character: null,
    title: null,
    frame: {
      id: `${id}-private-frame`,
      kind: "frame",
      name: { ar: "إطار", en: "Frame" },
      visualKey: "frame-2",
    },
  },
});
const issued = (id: string) => ({
  accessToken: `access-${id}`,
  refreshToken: `refresh-${id}`,
  expiresInSeconds: 3600,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real session logic, deferred transport: responses arrive only when each test permits them. */
function fixture() {
  const data = new Map<string, string>();
  const storage: SecretStorage = {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
  };
  const queue: Array<ReturnType<typeof pending>> = [];
  const logout = deferred<ApiResult>();
  let holdLogout = false;
  const client: Client = {
    request: async (request) => {
      if (request.path === "/v1/me") {
        const next = queue.shift();
        if (next === undefined) throw new Error("Missing profile response");
        next.started.resolve(request.accessToken);
        return next.response.promise;
      }
      if (request.path === "/v1/auth/logout") return holdLogout ? logout.promise : ok();
      return failed(401);
    },
  };
  function pending() {
    return { started: deferred<string | undefined>(), response: deferred<ApiResult>() };
  }
  const session = createSession({ client, storage, now: () => 0 });
  const states: PlayerState[] = [];
  const clear = vi.fn(async () => undefined);
  const loader = createPlayerLoader(session, (state) => states.push(state), clear);
  const stop = loader.watch();
  return {
    session,
    loader,
    states,
    clear,
    stop,
    logout,
    holdLogout: () => {
      holdLogout = true;
    },
    next: () => {
      const next = pending();
      queue.push(next);
      return next;
    },
  };
}

describe("the provider's account-bound profile loader", () => {
  it("cannot restore an account's private profile after sign-out completes", async () => {
    const f = fixture();
    await f.session.start(issued("A"));
    const old = f.next();
    const loading = f.loader.reload();
    expect(await old.started.promise).toBe("access-A");
    await f.loader.signOut();
    expect(f.states.at(-1)).toEqual({ status: "signed_out", ended: false });
    old.response.resolve(ok(profile("A")));
    await loading;
    expect(f.states).toEqual([{ status: "loading" }, { status: "signed_out", ended: false }]);
    expect(f.clear).toHaveBeenCalledOnce();
  });

  it("clears private data immediately and ignores reloads while logout is pending", async () => {
    const f = fixture();
    await f.session.start(issued("A"));
    const old = f.next();
    const loading = f.loader.reload();
    await old.started.promise;
    f.holdLogout();
    const signingOut = f.loader.signOut();
    await f.loader.reload();
    old.response.resolve(ok(profile("A")));
    await loading;
    expect(f.states).toEqual([{ status: "loading" }]);
    f.logout.resolve(ok());
    await signingOut;
    expect(f.states.at(-1)).toEqual({ status: "signed_out", ended: false });
  });

  it.each([ok(profile("A")), { kind: "network" } as const, failed(500), ok(null)])(
    "keeps account B when account A's earlier response arrives: %j",
    async (late) => {
      const f = fixture();
      await f.session.start(issued("A"));
      const old = f.next();
      const first = f.loader.reload();
      await old.started.promise;
      await f.session.start(issued("B"));
      const replacement = f.next();
      const second = f.loader.reload();
      expect(await replacement.started.promise).toBe("access-B");
      replacement.response.resolve(ok(profile("B")));
      await second;
      expect(f.states.at(-1)).toMatchObject({
        status: "signed_in",
        me: {
          id: "B",
          equipment: { frame: { id: "B-private-frame" } },
        },
      });
      const accepted = f.states.at(-1);
      old.response.resolve(late);
      await first;
      expect(f.states).toEqual([accepted]);
    },
  );

  it("cannot restore private data after a forced session end", async () => {
    const f = fixture();
    await f.session.start(issued("A"));
    const old = f.next();
    const loading = f.loader.reload();
    await old.started.promise;
    await f.session.request({ method: "GET", path: "/v1/ended" });
    expect(f.states.at(-1)).toEqual({ status: "signed_out", ended: true });
    old.response.resolve(ok(profile("A")));
    await loading;
    expect(f.states).toEqual([{ status: "signed_out", ended: true }]);
    expect(f.clear).toHaveBeenCalledOnce();
  });

  it("invalidates an outstanding load when the provider unmounts", async () => {
    const f = fixture();
    await f.session.start(issued("A"));
    const old = f.next();
    const loading = f.loader.reload();
    await old.started.promise;
    f.stop();
    old.response.resolve(ok(profile("A")));
    await loading;
    await f.loader.reload();
    expect(f.states).toEqual([]);
  });

  it("ignores an obsolete signed-in check before it can issue a request", async () => {
    const f = fixture();
    const signedIn = deferred<boolean>();
    const session = { ...f.session, signedIn: () => signedIn.promise };
    const states: PlayerState[] = [];
    const loader = createPlayerLoader(session, (state) => states.push(state), f.clear);
    loader.watch();
    const loading = loader.reload();
    await loader.signOut();
    signedIn.resolve(true);
    await loading;
    expect(states.at(-1)).toEqual({ status: "signed_out", ended: false });
  });
});
