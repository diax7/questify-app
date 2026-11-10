import * as SecureStore from "expo-secure-store";
import { MY_QR_KEY } from "#src/api/session.ts";

/** Where My QR keeps its token on a phone: the keychain, readable after the first unlock, never copied to another phone. */
export const myQrStore = {
  read: (): Promise<string | null> => SecureStore.getItemAsync(MY_QR_KEY).catch(() => null),
  write: (token: string): Promise<void> =>
    SecureStore.setItemAsync(MY_QR_KEY, token, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }).catch(() => undefined),
};
