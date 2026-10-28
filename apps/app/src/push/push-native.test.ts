import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, channelNames } from "#src/push/channels.ts";

const natives = vi.hoisted(() => ({
  optional: vi.fn<(name: string) => unknown>(),
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: natives.optional }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

const { createPushNative, pushEvents, pushNative } = await import("#src/push/push-native.ts");

const ALL = [
  "ExpoPushTokenManager",
  "ExpoNotificationPermissionsModule",
  "ExpoNotificationsEmitter",
  "ExpoNotificationsHandlerModule",
  "ExpoDevice",
  "ExpoApplication",
  "ExpoNotificationChannelManager",
];

/** A stand-in for the `expo-notifications` module with every call a spy. */
function fakeNotifications() {
  const remove = vi.fn();
  return {
    remove,
    AndroidImportance: { HIGH: 6, DEFAULT: 5 },
    AndroidNotificationVisibility: { PUBLIC: 1, PRIVATE: 2 },
    getPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
    requestPermissionsAsync: vi.fn(async (_options?: unknown) => ({ status: "granted" })),
    getDevicePushTokenAsync: vi.fn(async () => ({ type: "ios", data: "AB12" })),
    setNotificationChannelAsync: vi.fn(async () => null),
    setNotificationHandler: vi.fn(),
    addPushTokenListener: vi.fn((_listener: unknown) => ({ remove })),
    addNotificationReceivedListener: vi.fn((_listener: unknown) => ({ remove })),
    addNotificationResponseReceivedListener: vi.fn((_listener: unknown) => ({ remove })),
    getLastNotificationResponse: vi.fn(() => ({ actionIdentifier: "x" })),
    clearLastNotificationResponse: vi.fn(),
  };
}

/** The first argument a spy was called with. */
function firstArgument<T>(spy: Readonly<{ mock: Readonly<{ calls: readonly unknown[][] }> }>): T {
  const call = spy.mock.calls[0];
  if (call === undefined) throw new Error("the spy was never called");
  return call[0] as T;
}

function build(
  over: Readonly<{ os?: string; missing?: readonly string[]; device?: boolean }> = {},
) {
  const notifications = fakeNotifications();
  const application = {
    getIosPushNotificationServiceEnvironmentAsync: vi.fn(async () => "development"),
  };
  const loaders = {
    notifications: vi.fn(() => notifications),
    application: vi.fn(() => application),
  };
  const has = vi.fn((name: string) => ALL.includes(name) && !(over.missing ?? []).includes(name));
  const built = createPushNative({
    os: over.os ?? "ios",
    has,
    isDevice: () => over.device ?? true,
    modules: loaders as never,
  });
  return { ...built, notifications, application, loaders, has };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("when push is available", () => {
  it.each(["ios", "android"])("is available on a physical %s phone with every module", (os) => {
    expect(build({ os }).native.available()).toBe(true);
  });

  it("is not available on the web, or on a simulator or emulator", () => {
    expect(build({ os: "web" }).native.available()).toBe(false);
    expect(build({ device: false }).native.available()).toBe(false);
  });

  it.each([
    ["ExpoPushTokenManager", "ios"],
    ["ExpoNotificationPermissionsModule", "android"],
    ["ExpoNotificationsEmitter", "ios"],
    ["ExpoNotificationsHandlerModule", "android"],
    ["ExpoDevice", "ios"],
    ["ExpoApplication", "ios"],
    ["ExpoNotificationChannelManager", "android"],
  ])("is not available in a build without %s (%s)", (missing, os) => {
    expect(build({ os, missing: [missing] }).native.available()).toBe(false);
  });

  it("does not need the iOS-only or Android-only module on the other platform", () => {
    expect(build({ os: "android", missing: ["ExpoApplication"] }).native.available()).toBe(true);
    expect(
      build({ os: "ios", missing: ["ExpoNotificationChannelManager"] }).native.available(),
    ).toBe(true);
  });

  it("answers from memory after the first look", () => {
    const f = build();
    f.native.available();
    f.has.mockClear();
    f.native.available();
    expect(f.has).not.toHaveBeenCalled();
  });
});

describe("a build without the native modules", () => {
  it("loads neither package and does nothing when asked to listen", () => {
    const f = build({ missing: ["ExpoPushTokenManager", "ExpoNotificationsEmitter"] });
    f.events.showForegroundBanners();
    for (const stop of [
      f.events.onToken(vi.fn()),
      f.events.onReceive(vi.fn()),
      f.events.onResponse(vi.fn()),
    ]) {
      expect(() => stop()).not.toThrow();
    }
    expect(f.events.lastResponse()).toBeNull();
    expect(() => f.events.clearLastResponse()).not.toThrow();
    expect(f.loaders.notifications).not.toHaveBeenCalled();
    expect(f.loaders.application).not.toHaveBeenCalled();
  });

  it("loads neither package when the phone is a simulator", () => {
    const f = build({ device: false });
    f.events.showForegroundBanners();
    f.events.onResponse(vi.fn());
    expect(f.loaders.notifications).not.toHaveBeenCalled();
  });

  it("is off in the real module when every native module is missing", () => {
    natives.optional.mockReturnValue(null);
    expect(pushNative.available()).toBe(false);
    pushEvents.showForegroundBanners();
    expect(pushEvents.lastResponse()).toBeNull();
    expect(natives.optional).toHaveBeenCalled();
  });
});

describe("the permission", () => {
  it.each([
    ["granted", "granted"],
    ["undetermined", "undetermined"],
    ["denied", "denied"],
    ["blocked", "denied"],
    [undefined, "denied"],
  ])("reads the system's %s as %s", async (status, expected) => {
    const f = build();
    f.notifications.getPermissionsAsync.mockResolvedValueOnce({ status } as never);
    expect(await f.native.permission()).toBe(expected);
  });

  it("asks for an alert and a sound, never a badge", async () => {
    const f = build();
    f.notifications.requestPermissionsAsync.mockResolvedValueOnce({ status: "denied" });
    expect(await f.native.ask()).toBe("denied");
    expect(f.notifications.requestPermissionsAsync).toHaveBeenCalledExactlyOnceWith({
      ios: { allowAlert: true, allowBadge: false, allowSound: true },
    });
  });
});

describe("the token and the environment", () => {
  it("gives the token as text and the build's APNs environment as it is", async () => {
    const f = build();
    expect(await f.native.deviceToken()).toBe("AB12");
    expect(await f.native.apnsEnvironment()).toBe("development");
    f.application.getIosPushNotificationServiceEnvironmentAsync.mockResolvedValueOnce(
      null as never,
    );
    expect(await f.native.apnsEnvironment()).toBeNull();
  });
});

describe("the Android channels", () => {
  it("creates all six, with the lock screen private for personal and offers only", async () => {
    const f = build({ os: "android" });
    await f.native.ensureChannels(channelNames((key) => `name:${key}`));
    const made = f.notifications.setNotificationChannelAsync.mock.calls as unknown as Array<
      [string, { name: string; importance: number; lockscreenVisibility: number }]
    >;
    expect(made.map(([id]) => id)).toEqual(CHANNELS.map((channel) => channel.id));
    const byId = Object.fromEntries(made.map(([id, config]) => [id, config]));
    expect(byId["personal"]).toMatchObject({ importance: 6, lockscreenVisibility: 2 });
    expect(byId["offers"]).toMatchObject({ importance: 5, lockscreenVisibility: 2 });
    expect(byId["announcements"]).toMatchObject({ importance: 6, lockscreenVisibility: 1 });
    for (const id of ["rank", "community", "reminders"]) {
      expect(byId[id], id).toMatchObject({ importance: 5, lockscreenVisibility: 1 });
    }
    expect(byId["rank"]?.name).toBe("name:pushTopic.rank");
  });

  it("creates none on iOS", async () => {
    const f = build({ os: "ios" });
    await f.native.ensureChannels(channelNames((key) => key));
    expect(f.notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  });
});

describe("the events", () => {
  it("shows a push that arrives with the app open as a quiet banner", async () => {
    const f = build();
    f.events.showForegroundBanners();
    const [handler] = f.notifications.setNotificationHandler.mock.calls[0] as unknown as [
      { handleNotification: () => Promise<unknown> },
    ];
    expect(await handler.handleNotification()).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  it("passes the token, the arrival and the tap on, and each stop removes its listener", () => {
    const f = build();
    const token = vi.fn();
    const received = vi.fn();
    const tapped = vi.fn();
    const stops = [
      f.events.onToken(token),
      f.events.onReceive(received),
      f.events.onResponse(tapped),
    ];
    const tokenListener = firstArgument<(token: unknown) => void>(
      f.notifications.addPushTokenListener,
    );
    tokenListener({ type: "android", data: "fcm-token" });
    expect(token).toHaveBeenCalledWith("fcm-token");
    firstArgument<() => void>(f.notifications.addNotificationReceivedListener)();
    expect(received).toHaveBeenCalledWith();
    expect(f.notifications.addNotificationResponseReceivedListener).toHaveBeenCalledWith(tapped);
    for (const stop of stops) stop();
    expect(f.notifications.remove).toHaveBeenCalledTimes(3);
  });

  it("reads and clears the tap that started the app", () => {
    const f = build();
    expect(f.events.lastResponse()).toEqual({ actionIdentifier: "x" });
    f.events.clearLastResponse();
    expect(f.notifications.clearLastNotificationResponse).toHaveBeenCalledOnce();
  });
});

const PACKAGES = ["expo-notifications", "expo-application"];

/**
 * Whether a source file loads one of the packages as it loads: a static import or re-export of a value (not `import
 * type`), a bare `import "pkg"`, or a dynamic `import("pkg")`. A `require` is checked apart.
 */
function loadsOnImport(source: string, name: string): boolean {
  const quoted = `["']${name}["']`;
  return [
    new RegExp(`^\\s*(import|export)\\s+(?!type\\b)[^;]*?\\bfrom\\s+${quoted}`, "m"),
    new RegExp(`^\\s*import\\s+${quoted}`, "m"),
    new RegExp(`\\bimport\\(\\s*${quoted}`),
  ].some((pattern) => pattern.test(source));
}

describe("the scan for loading either package", () => {
  it.each([
    'import * as Notifications from "expo-notifications";',
    'import { getPermissionsAsync } from "expo-notifications";',
    'import "expo-notifications";',
    'const module = await import("expo-notifications");',
    'export * from "expo-application";',
    'import * as Application from "expo-application";',
  ])("catches %j", (source) => {
    expect(PACKAGES.some((name) => loadsOnImport(source, name))).toBe(true);
  });

  it.each([
    'import type * as Notifications from "expo-notifications";',
    'import type { NotificationResponse } from "expo-notifications";',
    'import type * as Application from "expo-application";',
    '// import "expo-notifications";',
    'import { thing } from "expo-notifications-helpers";',
  ])("lets %j through", (source) => {
    expect(PACKAGES.some((name) => loadsOnImport(source, name))).toBe(false);
  });
});

/**
 * A plain import of `expo-notifications` throws as it loads on a build without its native modules, which would stop
 * an older development build at launch. Types are erased and safe; only `push-native.ts` may require them, inside the
 * loaders that run after `available()` found every module.
 */
describe("where the two packages may be loaded", () => {
  const roots = [join(import.meta.dirname, "..", "..", "app"), join(import.meta.dirname, "..")];
  const files = roots.flatMap((root) =>
    readdirSync(root, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name)),
  );

  it("finds the app's sources", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never loads either package on import, outside the type-only imports", () => {
    // This file holds the scan's own samples, written as strings.
    const scanned = files.filter((file) => !file.endsWith("push-native.test.ts"));
    const offenders = scanned.filter((file) => {
      const source = readFileSync(file, "utf8");
      return PACKAGES.some((name) => loadsOnImport(source, name));
    });
    expect(offenders).toEqual([]);
  });

  it("requires them only in push-native.ts", () => {
    const requirers = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return PACKAGES.some((name) => new RegExp(`require\\(\\s*["']${name}["']`).test(source));
    });
    expect(requirers.map((file) => file.replaceAll("\\", "/").split("/").pop())).toEqual([
      "push-native.ts",
    ]);
  });
});
