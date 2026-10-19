import { getLocales } from "expo-localization";
import { reloadAppAsync } from "expo";
import { I18nManager } from "react-native";
import type { Language } from "@questify/shared";
import type { DeviceLocale } from "#src/i18n/language.ts";
import { isRtl } from "#src/i18n/language.ts";

/** The phone's languages, most preferred first. */
export function deviceLocales(): readonly DeviceLocale[] {
  return getLocales();
}

/** The layout direction the app started with. React Native reads it once, at launch. */
export function layoutIsRtl(): boolean {
  return I18nManager.isRTL;
}

/** Tells React Native which direction the next launch must use. It takes effect after a restart. */
export function applyDirectionForNextLaunch(language: Language): void {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(isRtl(language));
}

/**
 * Reopens the app so the new layout direction applies everywhere. `reloadAppAsync` is Expo's restart for every kind of
 * build (Expo Go, development builds and the store app).
 */
export async function restartApp(): Promise<void> {
  await reloadAppAsync("language changed");
}
