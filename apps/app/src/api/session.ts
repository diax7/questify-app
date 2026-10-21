import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";

/** Where the session lives: the secure store on a phone (injected, so the logic runs in tests too). */
export type SecretStorage = Readonly<{
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
}>;

/** The tokens the API issues at sign-in, sign-up and refresh (`/v1/auth/verify`, `/signup`, `/refresh`). */
export type Issued = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}>;

type Pair = Readonly<{ access: string; refresh: string; expiresAt: number }>;

export type AuthedResult = ApiResult | Readonly<{ kind: "signed_out" }>;

export type Session = Readonly<{
  /** Keeps a new sign-in's tokens. */
  start: (issued: Issued) => Promise<void>;
  signedIn: () => Promise<boolean>;
  /** Calls a player route with the access token, refreshing first when it is about to end and once after a 401. */
  request: (request: Omit<ApiRequest, "accessToken">) => Promise<AuthedResult>;
  /** Signs this device out at the API and here; the local sign-out happens even when the call fails. */
  signOut: () => Promise<void>;
  /** Called when the session ended on its own (a refused refresh), so the app can show sign-in. */
  onEnded: (listener: () => void) => () => void;
}>;

/** One secure-store item: access, refresh and expiry are written together, so they can never tear apart. */
export const SESSION_KEY = "questify.session";

/** Refresh when less than this is left (the API's access token lives an hour). */
const REFRESH_MARGIN_MS = 60_000;

export type SessionDeps = Readonly<{ client: Client; storage: SecretStorage; now?: () => number }>;

// Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent: `load` reads it inside a try, which turns a null into "no session" either way
const isPair = (value: unknown): value is Pair =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Pair).access === "string" &&
  typeof (value as Pair).refresh === "string" &&
  typeof (value as Pair).expiresAt === "number";

// Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent for the answers the API can send: a string or null body has no token fields
const isIssued = (value: unknown): value is Issued =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Issued).accessToken === "string" &&
  typeof (value as Issued).refreshToken === "string" &&
  typeof (value as Issued).expiresInSeconds === "number";

type Refreshed = "refreshed" | "ended" | "unreachable";

/**
 * The player's session on this device (T-107's rotating tokens). One refresh is in flight at a time: two would present
 * the same refresh token, and the API ends the device's sign-in on a reuse it cannot explain. Only a 401 from the
 * refresh ends the session; a network failure or any other answer keeps the tokens for the next try, inside the API's
 * 60-second grace for a lost answer.
 */
export function createSession(deps: SessionDeps): Session {
  const now = deps.now ?? Date.now;
  const listeners = new Set<() => void>();
  let inFlight: Promise<Refreshed> | undefined;
  // A chosen sign-out is not "your session ended": a refresh that a late 401 starts meanwhile tells nobody.
  let signingOut = false;

  /** Deletes the stored pair; a store that fails to delete is reported to nobody, the pair is unusable anyway. */
  const forget = async () => {
    try {
      await deps.storage.delete(SESSION_KEY);
    } catch {
      // The next read fails the same way and answers "no session".
    }
  };

  /**
   * The stored pair. A store that cannot be read (Android's keystore can lose its key and fail to decrypt) is a lost
   * session: the item is deleted and the answer is "no session", never a rejected promise at launch.
   */
  const load = async (): Promise<Pair | undefined> => {
    let raw: string | null;
    try {
      raw = await deps.storage.get(SESSION_KEY);
    } catch {
      await forget();
      return undefined;
    }
    if (raw === null) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isPair(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const save = (issued: Issued) =>
    deps.storage.set(
      SESSION_KEY,
      JSON.stringify({
        access: issued.accessToken,
        refresh: issued.refreshToken,
        expiresAt: now() + issued.expiresInSeconds * 1000,
      } satisfies Pair),
    );

  const end = async () => {
    await forget();
    if (signingOut) {
      return;
    }
    for (const listener of listeners) {
      listener();
    }
  };

  const runRefresh = async (): Promise<Refreshed> => {
    const pair = await load();
    if (pair === undefined) {
      return "ended";
    }
    const answer = await deps.client.request({
      method: "POST",
      path: "/v1/auth/refresh",
      body: { refreshToken: pair.refresh },
    });
    if (answer.kind === "ok" && isIssued(answer.body)) {
      try {
        await save(answer.body);
      } catch {
        // The old pair stays; the API's grace gives a fresh pair for it on the next try.
        return "unreachable";
      }
      return "refreshed";
    }
    if (answer.kind === "error" && answer.status === 401) {
      await end();
      return "ended";
    }
    return "unreachable";
  };

  const refresh = (): Promise<Refreshed> => {
    inFlight ??= runRefresh().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  /** The access token to use now, refreshed first when it is about to end. */
  const access = async (): Promise<string | undefined> => {
    const pair = await load();
    if (pair === undefined) {
      return undefined;
    }
    if (pair.expiresAt - now() > REFRESH_MARGIN_MS) {
      return pair.access;
    }
    const refreshed = await refresh();
    return refreshed === "ended" ? undefined : (await load())?.access;
  };

  /** After a 401: a token another request already renewed, or a refresh, or why there is none. */
  const renewed = async (used: string): Promise<string | AuthedResult> => {
    const stored = (await load())?.access;
    // A late 401 for a token that a refresh already replaced: use the new one, no second rotation.
    if (stored !== undefined && stored !== used) {
      return stored;
    }
    const refreshed = await refresh();
    if (refreshed === "ended") {
      return { kind: "signed_out" };
    }
    if (refreshed === "unreachable") {
      return { kind: "network" };
    }
    const fresh = (await load())?.access;
    // Stryker disable next-line ConditionalExpression,ObjectLiteral,StringLiteral: unreachable: a refresh that answered "refreshed" has just stored the pair
    return fresh ?? { kind: "signed_out" };
  };

  return {
    start: save,
    signedIn: async () => (await load()) !== undefined,
    request: async (request) => {
      const token = await access();
      if (token === undefined) {
        return { kind: "signed_out" };
      }
      const first = await deps.client.request({ ...request, accessToken: token });
      if (first.kind !== "error" || first.status !== 401) {
        return first;
      }
      // Once only: a second 401 is the answer, never a loop.
      const next = await renewed(token);
      return typeof next === "string"
        ? deps.client.request({ ...request, accessToken: next })
        : next;
    },
    signOut: async () => {
      signingOut = true;
      try {
        // A refresh in flight would rotate the token: wait for it, then sign out with the newest one.
        await inFlight?.catch(() => undefined);
        const pair = await load();
        if (pair !== undefined) {
          await deps.client.request({
            method: "POST",
            path: "/v1/auth/logout",
            body: { refreshToken: pair.refresh },
          });
        }
        await forget();
      } finally {
        signingOut = false;
      }
    },
    onEnded: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
