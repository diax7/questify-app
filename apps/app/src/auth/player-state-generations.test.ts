import { describe, expect, it } from "vitest";
import type { ApiRequest } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import { createPlayerLoader, type PlayerState } from "#src/auth/player-state.ts";

const ok = (body: unknown): AuthedResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(),
});
const profile = (id: string) => ({
  id,
  username: id,
  avatar: "falcon",
  legal: { toAccept: [], guidelinesAccepted: true },
  identifiers: { phone: null, email: null },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets every pending microtask run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A listener set's subscribe, which gives back the unsubscribe. */
const subscribe = (set: Set<() => void>) => (listener: () => void) => {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
};

/**
 * A session the test drives by hand: each profile request waits for the test's answer, the sign-in check and the
 * logout can be held, and the ended and legal-hold listeners are kept so the test can call them.
 */
function fakeSession() {
  const requests: Array<{
    request: Omit<ApiRequest, "accessToken">;
    answer: ReturnType<typeof deferred<AuthedResult>>;
  }> = [];
  const ended = new Set<() => void>();
  const holds = new Set<() => void>();
  const control = {
    signedIn: (): Promise<boolean> => Promise.resolve(true),
    logout: (): Promise<void> => Promise.resolve(),
    logouts: 0,
    checks: 0,
  };
  const session = {
    signedIn: () => {
      control.checks += 1;
      return control.signedIn();
    },
    request: (request: Omit<ApiRequest, "accessToken">) => {
      const answer = deferred<AuthedResult>();
      requests.push({ request, answer });
      return answer.promise;
    },
    signOut: () => {
      control.logouts += 1;
      return control.logout();
    },
    onEnded: subscribe(ended),
    onLegalHold: subscribe(holds),
  };
  const states: PlayerState[] = [];
  let clears = 0;
  let releases = 0;
  const loader = createPlayerLoader(
    session,
    (state) => states.push(state),
    async () => {
      clears += 1;
    },
    async () => {
      releases += 1;
    },
  );
  return {
    loader,
    states,
    requests,
    control,
    clears: () => clears,
    releases: () => releases,
    end: () => [...ended].forEach((listener) => listener()),
    hold: () => [...holds].forEach((listener) => listener()),
    answer: (index: number, result: AuthedResult) => requests[index]?.answer.resolve(result),
  };
}

const signedInAs = (state: PlayerState | undefined) =>
  state?.status === "signed_in" ? state.me?.id : state?.status;

describe("the profile loader's answers", () => {
  it("is signed out, not ended, when nobody is signed in, and asks the API nothing", async () => {
    const f = fakeSession();
    f.loader.watch();
    f.control.signedIn = async () => false;
    await f.loader.reload();
    expect(f.states).toEqual([{ status: "signed_out", ended: false }]);
    expect(f.requests).toEqual([]);
  });

  it("reads the profile with a GET of /v1/me", async () => {
    const f = fakeSession();
    f.loader.watch();
    const loading = f.loader.reload();
    await flush();
    expect(f.requests.map((entry) => entry.request)).toEqual([{ method: "GET", path: "/v1/me" }]);
    f.answer(0, ok(profile("A")));
    await loading;
    expect(f.states.map(signedInAs)).toEqual(["A"]);
  });

  it("shows the session ended when the profile request finds the player signed out", async () => {
    const f = fakeSession();
    f.loader.watch();
    const loading = f.loader.reload();
    await flush();
    f.answer(0, { kind: "signed_out" });
    await loading;
    expect(f.states).toEqual([{ status: "signed_out", ended: true }]);
  });

  it("publishes nothing for a signed-in check that answers after the provider unmounted", async () => {
    const f = fakeSession();
    const stop = f.loader.watch();
    const check = deferred<boolean>();
    f.control.signedIn = () => check.promise;
    const loading = f.loader.reload();
    stop();
    check.resolve(false);
    await loading;
    expect(f.states).toEqual([]);
  });
});

describe("an earlier account's late profile (generation guards)", () => {
  it("stays stale after a sign-out and the next sign-in's reload", async () => {
    const f = fakeSession();
    f.loader.watch();
    const first = f.loader.reload();
    await flush();
    await f.loader.signOut();
    const second = f.loader.reload();
    await flush();
    f.answer(1, ok(profile("B")));
    await second;
    f.answer(0, ok(profile("A")));
    await first;
    expect(f.states.map(signedInAs)).toEqual(["loading", "signed_out", "B"]);
  });

  it("stays stale after a forced session end and the next reload", async () => {
    const f = fakeSession();
    f.loader.watch();
    const first = f.loader.reload();
    await flush();
    f.end();
    const second = f.loader.reload();
    await flush();
    f.answer(1, ok(profile("B")));
    await second;
    f.answer(0, ok(profile("A")));
    await first;
    expect(f.states.map(signedInAs)).toEqual(["signed_out", "B"]);
    expect(f.clears()).toBe(1);
  });

  it("stays stale after the provider unmounts and mounts again", async () => {
    const f = fakeSession();
    const stop = f.loader.watch();
    const first = f.loader.reload();
    await flush();
    stop();
    f.loader.watch();
    const second = f.loader.reload();
    await flush();
    f.answer(1, ok(profile("B")));
    await second;
    f.answer(0, ok(profile("A")));
    await first;
    expect(f.states.map(signedInAs)).toEqual(["B"]);
  });

  it("keeps a forced end on screen when the sign-out under way finishes after it", async () => {
    const f = fakeSession();
    f.loader.watch();
    const logout = deferred<void>();
    f.control.logout = () => logout.promise;
    const signingOut = f.loader.signOut();
    await flush();
    f.end();
    logout.resolve();
    await signingOut;
    expect(f.states).toEqual([{ status: "loading" }, { status: "signed_out", ended: true }]);
  });
});

describe("the loader's listeners and sign-out", () => {
  it("hears no session end once the provider unmounts", () => {
    const f = fakeSession();
    const stop = f.loader.watch();
    stop();
    f.end();
    expect(f.states).toEqual([]);
    expect(f.clears()).toBe(0);
  });

  it("reloads once for a legal hold after a remount, not once per mount", async () => {
    const f = fakeSession();
    const stop = f.loader.watch();
    stop();
    f.loader.watch();
    f.hold();
    await flush();
    expect([f.control.checks, f.requests.length]).toEqual([1, 1]);
  });

  it("does nothing for a sign-out after the provider unmounted", async () => {
    const f = fakeSession();
    const stop = f.loader.watch();
    stop();
    await f.loader.signOut();
    expect([f.states, f.releases(), f.control.logouts, f.clears()]).toEqual([[], 0, 0, 0]);
  });

  it("runs one sign-out for a second tap while the first is under way", async () => {
    const f = fakeSession();
    f.loader.watch();
    const logout = deferred<void>();
    f.control.logout = () => logout.promise;
    const first = f.loader.signOut();
    await f.loader.signOut();
    logout.resolve();
    await first;
    expect([f.releases(), f.control.logouts, f.clears()]).toEqual([1, 1, 1]);
  });

  it("loads the next account's profile once a sign-out is over", async () => {
    const f = fakeSession();
    f.loader.watch();
    await f.loader.signOut();
    const loading = f.loader.reload();
    await flush();
    f.answer(0, ok(profile("B")));
    await loading;
    expect(f.states.map(signedInAs)).toEqual(["loading", "signed_out", "B"]);
  });
});
