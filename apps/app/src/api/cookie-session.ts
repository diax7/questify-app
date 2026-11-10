import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import { announceHold, createNotifier, type AuthedResult, type Session } from "#src/api/session.ts";

/**
 * Runs `task` while this browser holds the refresh lock: `navigator.locks` across tabs, which share one cookie jar
 * (ADR-821). Two tabs refreshing within the API's 60-second grace could store a revoked successor, and the next
 * refresh would read as reuse and end the family.
 */
export type RefreshLock = <T>(task: () => Promise<T>) => Promise<T>;

export type CookieSessionDeps = Readonly<{
  client: Client;
  /** The cross-tab lock when the browser has one; undefined keeps the in-tab one only (the cross-tab race remains). */
  lock?: RefreshLock;
  /** Drops the account's own items (My QR lives in memory only on the web). */
  dropAccountItems?: () => void;
}>;

type Refreshed = "refreshed" | "ended" | "signed_out" | "unreachable";

/** One task at a time in this tab, in order (`navigator.locks` gives the same across tabs). */
function inTabLock(): RefreshLock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

const isUnauthorized = (answer: ApiResult): boolean =>
  answer.kind === "error" && answer.status === 401;

const isSignedIn = (body: unknown): boolean =>
  typeof body === "object" && body !== null && (body as { signedIn?: unknown }).signedIn === true;

/**
 * The player's session in a browser (T-803 P2, ADR-818): the web app's forwarder keeps the tokens in its HttpOnly
 * cookie, so this side holds none and never sends an access token. A 401 takes the lock, retries the request once
 * (another tab may have refreshed already), and only then refreshes; only `session_expired` from the refresh ends the
 * session and tells the app.
 */
export function createCookieSession(deps: CookieSessionDeps): Session {
  const lock = deps.lock ?? inTabLock();
  const ended = createNotifier();
  const held = createNotifier();
  let inFlight: Promise<Refreshed> | undefined;
  let signingOut = false;

  const runRefresh = async (): Promise<Refreshed> => {
    const answer = await deps.client.request({
      method: "POST",
      path: "/v1/auth/refresh",
      body: {},
    });
    if (answer.kind === "ok") {
      return "refreshed";
    }
    if (answer.kind === "error" && answer.code === "session_expired") {
      deps.dropAccountItems?.();
      if (!signingOut) {
        ended.notify();
      }
      return "ended";
    }
    return isUnauthorized(answer) ? "signed_out" : "unreachable";
  };

  const refresh = (): Promise<Refreshed> => {
    inFlight ??= runRefresh().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  /** After a 401: inside the lock, the request once more, then one refresh when that is a 401 too. */
  const recover = (request: ApiRequest): Promise<ApiResult | Refreshed> =>
    lock(async () => {
      const again = await deps.client.request(request);
      return isUnauthorized(again) ? refresh() : again;
    });

  const call = async (request: ApiRequest): Promise<AuthedResult> => {
    const first = await deps.client.request(request);
    if (!isUnauthorized(first)) {
      return first;
    }
    const next = await recover(request);
    if (typeof next !== "string") {
      return next;
    }
    if (next === "refreshed") {
      return deps.client.request(request);
    }
    return next === "unreachable" ? { kind: "network" } : { kind: "signed_out" };
  };

  /** `GET /v1/me`, with one refresh after a 401: true unless the browser holds no session at all. */
  const probe = async (): Promise<boolean> => {
    const me: ApiRequest = { method: "GET", path: "/v1/me" };
    const first = await deps.client.request(me);
    if (!isUnauthorized(first)) {
      return true;
    }
    const next = await recover(me);
    // `ended` stays true: the app has been told, and the loader shows "your session ended".
    return next !== "signed_out";
  };

  return {
    start: async (body) => {
      if (!isSignedIn(body)) {
        return false;
      }
      deps.dropAccountItems?.();
      return true;
    },
    signedIn: probe,
    request: async (request) => announceHold(held, await call(request)),
    signOut: async () => {
      signingOut = true;
      try {
        await inFlight?.catch(() => undefined);
        await deps.client.request({ method: "POST", path: "/v1/auth/logout", body: {} });
        deps.dropAccountItems?.();
      } finally {
        signingOut = false;
      }
    },
    onEnded: ended.subscribe,
    onLegalHold: held.subscribe,
  };
}
