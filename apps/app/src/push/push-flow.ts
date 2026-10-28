import type { Language, PushDeviceBody } from "@questify/shared";
import type { Session } from "#src/api/session.ts";
import type { ChannelNames } from "#src/push/channels.ts";

/**
 * The app's push rules (T-501c, ADR-349), over an injected phone so they run in tests: when the permission is asked,
 * how the device registers with the server and how it leaves. Nothing here pays, opens or blocks anything for the
 * permission's answer (FR-1106): a refused permission changes only what Settings says.
 */

export type PermissionState = "granted" | "undetermined" | "denied";

/** What the phone gives push. `expo-notifications` and `expo-application` sit behind it (`push-native.ts`). */
export type PushNative = Readonly<{
  /** True on a physical phone whose build holds every native module push needs; false everywhere else. */
  available: () => boolean;
  platform: () => "ios" | "android";
  permission: () => Promise<PermissionState>;
  /** Opens the system prompt (iOS asks once; Android 13 and later may ask again after one refusal). */
  ask: () => Promise<PermissionState>;
  /** The phone's own push token as text (APNs hex or FCM); rejects when the phone gives none. */
  deviceToken: () => Promise<string>;
  /** `development` or `production` from the build's provisioning, or null (App Store and TestFlight builds). */
  apnsEnvironment: () => Promise<string | null>;
  /** Creates the Android channels (named in the app's language); nothing on iOS. */
  ensureChannels: (names: ChannelNames) => Promise<void>;
}>;

/** AsyncStorage's three calls (injected, so the logic runs in tests). */
export type KeyValueStore = Readonly<{
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}>;

export type PushDeps = Readonly<{
  native: PushNative;
  session: Pick<Session, "request">;
  store: KeyValueStore;
  now: () => number;
}>;

/** What the server was last told about this install; removed at every sign-out (`PLAYER_KEYS`). */
export const REGISTRATION_KEY = "questify.push.registration";
/** When the explainer was last answered "Not now". It belongs to the phone, not the player, and stays at sign-out. */
export const EXPLAINER_KEY = "questify.push.explainer";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The server's device bucket is 20 an hour: the same device registers at most once a day (plan, "The app"). */
export const REGISTRATION_INTERVAL_MS = DAY_MS;
/** "Not now" waits this long before the explainer is offered again (ADR-349 (1)). */
export const EXPLAINER_SNOOZE_MS = 30 * DAY_MS;

export type ApnsEnvironment = "sandbox" | "production";

/**
 * The server's APNs host for this build. `development` is sandbox; `production`, `null` (every App Store and TestFlight
 * install, whose provisioning file Apple strips) and any other answer are production, Expo's own rule (ADR-344 (5)).
 */
export const apnsEnvironmentOf = (raw: string | null): ApnsEnvironment =>
  raw === "development" ? "sandbox" : "production";

type Registration = Readonly<{
  token: string;
  environment: ApnsEnvironment | null;
  language: Language;
  appVersion: string;
  at: number;
}>;

const APP_VERSION = /^[0-9A-Za-z.+-]{1,20}$/;
/** Sent when the build's version cannot be read, so the server's field check still passes. */
const UNKNOWN_VERSION = "unknown";

export const appVersionOf = (version: string | null | undefined): string =>
  version !== null && version !== undefined && APP_VERSION.test(version)
    ? version
    : UNKNOWN_VERSION;

const isEnvironment = (value: unknown): boolean =>
  value === null || value === "sandbox" || value === "production";

function isRegistration(value: unknown): value is Registration {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["token"] === "string" &&
    typeof record["language"] === "string" &&
    typeof record["appVersion"] === "string" &&
    typeof record["at"] === "number" &&
    isEnvironment(record["environment"])
  );
}

/** The stored record, or null when there is none or it cannot be read (the device is then told to the server again). */
function readRegistration(raw: string | null): Registration | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isRegistration(value) ? value : null;
  } catch {
    return null;
  }
}

const loadRegistration = async (store: KeyValueStore): Promise<Registration | null> =>
  readRegistration(await store.getItem(REGISTRATION_KEY).catch(() => null));

/** The device body for `PUT /v1/me/push-device`; iOS tokens are sent lower-case and name the APNs environment. */
export function deviceBody(
  platform: "ios" | "android",
  token: string,
  environment: ApnsEnvironment | null,
  language: Language,
  appVersion: string,
): PushDeviceBody {
  return platform === "ios"
    ? {
        platform,
        token: token.toLowerCase(),
        environment: environment ?? "production",
        language,
        appVersion,
      }
    : { platform, token, language, appVersion };
}

export type SyncResult = "registered" | "unchanged" | "off" | "failed";

export type SyncWho = Readonly<{
  language: Language;
  /** The build's version from its config (`expo-constants`). */
  appVersion: string | null | undefined;
}>;

/** The token and, on iOS, the environment this phone would register now; null when the phone gives no token. */
async function currentDevice(
  native: PushNative,
  given: string | undefined,
): Promise<{ token: string; environment: ApnsEnvironment | null } | null> {
  const token = given ?? (await native.deviceToken().catch(() => null));
  if (token === null || token === "") return null;
  if (native.platform() !== "ios") return { token, environment: null };
  return {
    token,
    environment: apnsEnvironmentOf(await native.apnsEnvironment().catch(() => null)),
  };
}

/** Whether the server already holds exactly this device, told less than a day ago. */
function isCurrent(known: Registration | null, sent: PushDeviceBody, now: number): boolean {
  if (known === null) return false;
  const same =
    known.token === sent.token &&
    known.environment === (sent.environment ?? null) &&
    known.language === sent.language &&
    known.appVersion === sent.appVersion;
  return same && now >= known.at && now - known.at < REGISTRATION_INTERVAL_MS;
}

/**
 * Tells the server about this phone when it must know: no record yet, a new token or environment, another language or
 * app version, or a day since the last time. Only with the permission granted on a physical phone. A failed call is
 * not recorded, so the next launch or foreground tries again; the caller never loops.
 *
 * @param token A token the phone just announced (a token change), else it is asked for.
 */
export async function syncRegistration(
  deps: PushDeps,
  who: SyncWho,
  token?: string,
): Promise<SyncResult> {
  const { native, session, store, now } = deps;
  if (!native.available() || (await native.permission().catch(() => "denied")) !== "granted") {
    return "off";
  }
  const device = await currentDevice(native, token);
  if (device === null) return "failed";
  const appVersion = appVersionOf(who.appVersion);
  const sent = deviceBody(
    native.platform(),
    device.token,
    device.environment,
    who.language,
    appVersion,
  );
  if (isCurrent(await loadRegistration(store), sent, now())) return "unchanged";
  const answer = await session.request({ method: "PUT", path: "/v1/me/push-device", body: sent });
  if (answer.kind !== "ok") return "failed";
  const record: Registration = {
    token: sent.token,
    environment: sent.environment ?? null,
    language: who.language,
    appVersion,
    at: now(),
  };
  await store.setItem(REGISTRATION_KEY, JSON.stringify(record)).catch(() => undefined);
  return "registered";
}

/**
 * Removes this sign-in's device before sign-out (best effort: the server stops pushes to a dead sign-in anyway) and
 * forgets the record. Nothing is called for a phone that never registered.
 */
export async function unregisterDevice(
  deps: Pick<PushDeps, "session" | "store">,
): Promise<boolean> {
  const known = await loadRegistration(deps.store);
  await deps.store.removeItem(REGISTRATION_KEY).catch(() => undefined);
  if (known === null) return false;
  const answer = await deps.session.request({ method: "DELETE", path: "/v1/me/push-device" });
  return answer.kind === "ok";
}

/**
 * Whether the explainer is offered now (FR-1105): the phone can do push, the system has not been asked (an answer,
 * either way, is final), and "Not now" was not tapped in the last 30 days. The caller asks only after a join.
 */
export async function explainerDue(deps: PushDeps): Promise<boolean> {
  const { native, store, now } = deps;
  if (!native.available()) return false;
  if ((await native.permission().catch(() => "denied")) !== "undetermined") return false;
  const raw = await store.getItem(EXPLAINER_KEY).catch(() => null);
  const until = raw === null ? Number.NaN : Number(raw);
  return !(Number.isFinite(until) && now() < until);
}

/** "Not now": no explainer for 30 days. */
export const snoozeExplainer = (deps: Pick<PushDeps, "store" | "now">): Promise<void> =>
  deps.store
    .setItem(EXPLAINER_KEY, String(deps.now() + EXPLAINER_SNOOZE_MS))
    .catch(() => undefined);

/**
 * "Turn on": creates the channels (Android 13 shows no prompt without one), shows the system prompt and, when it is
 * granted, registers at once. Returns the permission after.
 */
export async function turnOn(
  deps: PushDeps,
  who: SyncWho,
  names: ChannelNames,
): Promise<PermissionState> {
  const { native } = deps;
  if (!native.available()) return "denied";
  await native.ensureChannels(names).catch(() => undefined);
  const permission = await native.ask().catch(() => "denied" as const);
  if (permission === "granted") await syncRegistration(deps, who);
  return permission;
}
