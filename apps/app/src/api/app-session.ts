import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import type { Language } from "@questify/shared";
import { apiBaseUrl, createClient, type Client } from "#src/api/client.ts";
import { randomUuid } from "#src/api/uuid.ts";
import { SESSION_KEY, createSession, type SecretStorage, type Session } from "#src/api/session.ts";

/**
 * The phone's keychain or keystore, this device only: tokens never travel in a backup to another device
 * (MASVS-STORAGE).
 */
const secureStorage: SecretStorage = {
  // Every read waits for the install check, so a reinstall starts signed out whatever the launch asks first.
  get: async (key) => {
    await deviceId();
    return SecureStore.getItemAsync(key);
  },
  set: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
  delete: (key) => SecureStore.deleteItemAsync(key),
};

const INSTALL_KEY = "questify.install";

/**
 * The install id the API holds limits against (X-Device-Id). Made on the first launch of this install; on that launch
 * the secure store is also cleared, because the iOS keychain outlives an uninstall and must not bring a session back.
 */
async function installId(): Promise<string> {
  const known = await AsyncStorage.getItem(INSTALL_KEY);
  if (known !== null) {
    return known;
  }
  await SecureStore.deleteItemAsync(SESSION_KEY);
  const made = randomUuid();
  await AsyncStorage.setItem(INSTALL_KEY, made);
  return made;
}

let pendingInstall: Promise<string> | undefined;
export const deviceId = (): Promise<string> => {
  // A check that failed is tried again on the next call, not remembered as failed for the whole session.
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

/** The app's one client and session (the base URL is checked at start: a release build without it stops here). */
export const api: Readonly<{ client: Client; session: Session }> = (() => {
  const client = createClient({
    baseUrl: apiBaseUrl(process.env["EXPO_PUBLIC_API_URL"], __DEV__),
    deviceId,
    language: () => currentLanguage,
    appVersion: Constants.expoConfig?.version,
  });
  return { client, session: createSession({ client, storage: secureStorage }) };
})();

/** Where the app keeps small, non-secret state (the config copy, the chosen event). */
export const keyValueStore = AsyncStorage;
