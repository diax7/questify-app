import { TICKET_DEVICE_FACT, TICKET_DEVICE_MODEL_MAX } from "@questify/shared";

/** The phone's facts an app problem carries (T-312, ADR-259): no identifier, never the name the owner gave it. */
export type DeviceFacts = Readonly<{
  appVersion: string;
  platform: "ios" | "android";
  osVersion: string;
  model: string | null;
}>;

/** What the app knows when it builds the facts; every part may be missing on some build or platform. */
export type DeviceSources = Readonly<{
  /** The app's version from its config (`expo-constants`). */
  appVersion: string | null | undefined;
  /** `Platform.OS`. */
  os: string;
  /** `Platform.Version`: a string on iOS, the API level (a number) on Android. */
  osVersion: string | number | null | undefined;
  /** `Device.modelName` from `expo-device`; undefined in a build without the module. */
  modelName: string | null | undefined;
  /** Android's own model (`Platform.constants.Model`), the fallback there. */
  androidModel: string | null | undefined;
}>;

const cleanFact = (value: string | number | null | undefined): string | null => {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return TICKET_DEVICE_FACT.test(text) ? text : null;
};

// Control and direction characters never go to the server; it refuses them as well.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point: they are stripped
const UNSAFE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

const cleanModel = (value: string | null | undefined): string | null => {
  const text = (value ?? "").replace(UNSAFE, "").trim().slice(0, TICKET_DEVICE_MODEL_MAX);
  return text === "" ? null : text;
};

/**
 * The facts to send with an app problem, or null when the version, the platform or the OS cannot be read (the form
 * then cannot send an app problem, as the server would refuse it). The model is optional: null without `expo-device`
 * (Android falls back to its own model name).
 */
export function deviceFactsOf(sources: DeviceSources): DeviceFacts | null {
  const appVersion = cleanFact(sources.appVersion);
  const osVersion = cleanFact(sources.osVersion);
  if (appVersion === null || osVersion === null) {
    return null;
  }
  if (sources.os !== "ios" && sources.os !== "android") {
    return null;
  }
  const model =
    cleanModel(sources.modelName) ??
    (sources.os === "android" ? cleanModel(sources.androidModel) : null);
  return { appVersion, platform: sources.os, osVersion, model };
}

/** "Questify 1.4.0, iPhone 15 Pro, iOS 18.1": what the form says it will send. */
export function deviceLine(facts: DeviceFacts): string {
  const system = `${facts.platform === "ios" ? "iOS" : "Android"} ${facts.osVersion}`;
  return [`Questify ${facts.appVersion}`, facts.model, system]
    .filter((part) => part !== null)
    .join(", ");
}

type DeviceModule = Readonly<{ modelName?: string | null }>;

/**
 * `expo-device`'s model name, loaded only when the form asks; undefined when the binary was built before the module
 * was added (its load throws there), so an old development build still sends an app problem, without the model.
 */
export async function readModelName(
  load: () => Promise<DeviceModule>,
): Promise<string | null | undefined> {
  try {
    return (await load()).modelName;
  } catch {
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      // oxlint-disable-next-line no-console -- a developer-only hint with no personal data (CTO code review 4)
      console.warn(
        "expo-device is not in this build: an app problem is sent without the phone model.",
      );
    }
    return undefined;
  }
}
