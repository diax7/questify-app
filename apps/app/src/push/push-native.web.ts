import type { PushEvents } from "#src/push/push-native.ts";
import type { PushNative } from "#src/push/push-flow.ts";

/**
 * Push in the browser (T-803, Dhia Q5): none. The web build has no service worker and no push keys, so push is simply
 * unavailable, and the in-app notification centre, the bell and Settings still work. `expo-notifications` and
 * `expo-application` are never loaded here.
 */
const NO_STOP = (): void => undefined;

export const pushNative: PushNative = {
  available: () => false,
  platform: () => "android",
  permission: () => Promise.resolve("denied"),
  ask: () => Promise.resolve("denied"),
  deviceToken: () => Promise.reject(new Error("Push is not available in the browser.")),
  apnsEnvironment: () => Promise.resolve(null),
  ensureChannels: () => Promise.resolve(),
};

export const pushEvents: PushEvents = {
  showForegroundBanners: NO_STOP,
  onToken: () => NO_STOP,
  onReceive: () => NO_STOP,
  onResponse: () => NO_STOP,
  lastResponse: () => null,
  clearLastResponse: NO_STOP,
};
