import { readModelName } from "#src/help/device.ts";

/** What a sign-in tells the API about this phone (T-810c, ADR-710): the platform and the model, nothing else. */
export type DeviceLabel = Readonly<{ platform: "ios" | "android"; model?: string }>;

type DeviceModule = Readonly<{ modelName?: string | null }>;

const MODEL = /^[A-Za-z0-9 ._()+-]{1,40}$/;

/**
 * The label of this phone: its platform and `expo-device`'s model name, trimmed and kept only when it fits the API's
 * shape. Never the name the owner gave the phone, nor any identifier. A web build, or a build without
 * `expo-device`, sends the platform alone or nothing.
 */
export async function deviceLabelOf(
  os: string,
  load: () => Promise<DeviceModule>,
): Promise<DeviceLabel | undefined> {
  if (os !== "ios" && os !== "android") {
    return undefined;
  }
  const name = (await readModelName(load))?.trim().replace(/\s+/g, " ");
  return name !== undefined && name !== null && MODEL.test(name)
    ? { platform: os, model: name }
    : { platform: os };
}
