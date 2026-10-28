import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import type * as Application from "expo-application";
import type * as Notifications from "expo-notifications";
import { CHANNELS, type ChannelNames } from "#src/push/channels.ts";
import type { PermissionState, PushNative } from "#src/push/push-flow.ts";

/**
 * The only file that loads `expo-notifications` and `expo-application` (T-501c, ADR-349).
 * Importing `expo-notifications` throws as it loads when the build has no native module for it, so a development build
 * made before this task would crash at launch. Each package is therefore required only after
 * `requireOptionalNativeModule` found the native modules checked below. A build holds all of a package's native modules
 * or none, so these few stand for the whole set. Without them push is simply off (`available()` is false, listeners
 * are no-ops) and the center, the bell and Settings still work.
 */

/** Some of the native modules `expo-notifications` loads on both platforms, by their registered names. */
const NOTIFICATION_MODULES = [
  "ExpoPushTokenManager",
  "ExpoNotificationPermissionsModule",
  "ExpoNotificationsEmitter",
  "ExpoNotificationsHandlerModule",
] as const;
/** Android's channel manager (iOS has none), `expo-application` for the APNs environment (iOS only). */
const ANDROID_MODULES = ["ExpoNotificationChannelManager"] as const;
const IOS_MODULES = ["ExpoApplication"] as const;

export type PushModules = Readonly<{
  notifications: () => typeof Notifications;
  application: () => typeof Application;
}>;

export type PushSources = Readonly<{
  os: string;
  has: (nativeModule: string) => boolean;
  /** `expo-device`'s own constant: false on a simulator or an emulator. Read from its native module, not its package. */
  isDevice: () => boolean;
  modules: PushModules;
}>;

/** What the host listens to; every call is a no-op where push is not available. */
export type PushEvents = Readonly<{
  /** Shows a push that arrives while the app is open as a banner, silently. */
  showForegroundBanners: () => void;
  onToken: (listener: (token: string) => void) => () => void;
  onReceive: (listener: () => void) => () => void;
  /** A tap on a push (or one of its actions) as the module reports it; `tapOf` reads it. */
  onResponse: (listener: (response: unknown) => void) => () => void;
  /** The tap that opened the app from a killed state, else null. */
  lastResponse: () => unknown;
  clearLastResponse: () => void;
}>;

const NO_STOP = (): void => undefined;

const requiredModules = (os: string): readonly string[] =>
  os === "ios"
    ? [...NOTIFICATION_MODULES, ...IOS_MODULES]
    : [...NOTIFICATION_MODULES, ...ANDROID_MODULES];

const permissionOf = (status: unknown): PermissionState =>
  status === "granted" ? "granted" : status === "undetermined" ? "undetermined" : "denied";

/** The phone's push, over whatever the build holds. Built once; `available()` is asked often and answered from memory. */
export function createPushNative(sources: PushSources): Readonly<{
  native: PushNative;
  events: PushEvents;
}> {
  const { os, has, isDevice, modules } = sources;
  const platform = os === "ios" ? "ios" : "android";
  let known: boolean | undefined;

  const available = (): boolean => {
    known ??=
      (os === "ios" || os === "android") &&
      has("ExpoDevice") &&
      requiredModules(os).every(has) &&
      isDevice();
    return known;
  };

  const native: PushNative = {
    available,
    platform: () => platform,
    permission: async () =>
      permissionOf((await modules.notifications().getPermissionsAsync()).status),
    ask: async () =>
      permissionOf(
        (
          await modules.notifications().requestPermissionsAsync({
            ios: { allowAlert: true, allowBadge: false, allowSound: true },
          })
        ).status,
      ),
    deviceToken: async () => String((await modules.notifications().getDevicePushTokenAsync()).data),
    apnsEnvironment: () => modules.application().getIosPushNotificationServiceEnvironmentAsync(),
    ensureChannels: (names) => createChannels(modules.notifications(), os, names),
  };

  const events: PushEvents = {
    showForegroundBanners: () => {
      if (!available()) return;
      modules.notifications().setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: false,
          shouldSetBadge: false,
        }),
      });
    },
    onToken: (listener) =>
      available()
        ? subscription(
            modules.notifications().addPushTokenListener((token) => listener(String(token.data))),
          )
        : NO_STOP,
    onReceive: (listener) =>
      available()
        ? subscription(modules.notifications().addNotificationReceivedListener(() => listener()))
        : NO_STOP,
    onResponse: (listener) =>
      available()
        ? subscription(modules.notifications().addNotificationResponseReceivedListener(listener))
        : NO_STOP,
    lastResponse: () =>
      available() ? modules.notifications().getLastNotificationResponse() : null,
    clearLastResponse: () => {
      if (available()) modules.notifications().clearLastNotificationResponse();
    },
  };
  return { native, events };
}

const subscription = (handle: Readonly<{ remove: () => void }>) => (): void => handle.remove();

/** Android only: the six channels, `personal` and `offers` showing no text on a locked screen. */
async function createChannels(
  module: typeof Notifications,
  os: string,
  names: ChannelNames,
): Promise<void> {
  if (os !== "android") return;
  for (const channel of CHANNELS) {
    await module.setNotificationChannelAsync(channel.id, {
      name: names[channel.id],
      importance:
        channel.importance === "high"
          ? module.AndroidImportance.HIGH
          : module.AndroidImportance.DEFAULT,
      lockscreenVisibility:
        channel.lockscreen === "private"
          ? module.AndroidNotificationVisibility.PRIVATE
          : module.AndroidNotificationVisibility.PUBLIC,
    });
  }
}

/**
 * The real phone. The packages are required inside the loaders, which run only after `available()` found their native
 * modules, never when this file loads.
 */
export const { native: pushNative, events: pushEvents } = createPushNative({
  os: Platform.OS,
  has: (nativeModule) => requireOptionalNativeModule(nativeModule) != null,
  isDevice: () =>
    requireOptionalNativeModule<{ isDevice?: boolean }>("ExpoDevice")?.isDevice === true,
  modules: {
    notifications: () => require("expo-notifications") as typeof Notifications,
    application: () => require("expo-application") as typeof Application,
  },
});
