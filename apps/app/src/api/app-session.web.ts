import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import type { Language } from "@questify/shared";
import { createClient, type Client } from "#src/api/client.ts";
import { createCookieSession, type RefreshLock } from "#src/api/cookie-session.ts";
import type { Session } from "#src/api/session.ts";
import { randomUuid } from "#src/api/uuid.ts";

/**
 * The web build's client and session (T-803 P2, ADR-818): the same exports as `app-session.ts`, without SecureStore.
 * The web app's forwarder holds the tokens in its HttpOnly cookie, so nothing secret is kept here; the install id lives
 * in AsyncStorage (localStorage), which a person can clear or rotate (the per-install limit is no control on the web,
 * SECURITY.md).
 */

type BrowserGlobals = Readonly<{
  location?: { origin: string };
  navigator?: {
    locks?: { request: <T>(name: string, task: () => Promise<T>) => Promise<T> };
  };
}>;

const browser = globalThis as BrowserGlobals;

const INSTALL_KEY = "questify.install";

async function installId(): Promise<string> {
  const known = await AsyncStorage.getItem(INSTALL_KEY);
  if (known !== null) {
    return known;
  }
  const made = randomUuid();
  await AsyncStorage.setItem(INSTALL_KEY, made);
  return made;
}

let pendingInstall: Promise<string> | undefined;
export const deviceId = (): Promise<string> => {
  pendingInstall ??= installId().catch((error: unknown) => {
    pendingInstall = undefined;
    throw error;
  });
  return pendingInstall;
};

let currentLanguage: Language = "ar";

/** The language the API answers in, set by the i18n provider. */
export function setApiLanguage(language: Language): void {
  currentLanguage = language;
}

/** One refresh at a time across this browser's tabs (ADR-821); without `navigator.locks`, the session's in-tab lock. */
const locks = browser.navigator?.locks;
const refreshLock: RefreshLock | undefined =
  locks === undefined ? undefined : (task) => locks.request("questify.refresh", task);

/** The cookie goes with every call to this origin's `/v1` forwarder, and never anywhere else. */
const sameOriginFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, credentials: "same-origin" });

export const api: Readonly<{ client: Client; session: Session }> = (() => {
  const client = createClient({
    baseUrl: browser.location?.origin ?? "",
    deviceId,
    language: () => currentLanguage,
    appVersion: Constants.expoConfig?.version,
    fetchImpl: sameOriginFetch,
  });
  // My QR is memory only on the web: nothing of it is stored here to drop.
  return {
    client,
    session: createCookieSession({
      client,
      ...(refreshLock === undefined ? {} : { lock: refreshLock }),
    }),
  };
})();

/** Where the app keeps small, non-secret state (the config copy, the chosen event). */
export const keyValueStore = AsyncStorage;
