import { getLocales } from "expo-localization";
import * as Updates from "expo-updates";
import { DevSettings, I18nManager } from "react-native";
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

/** Reopens the app on the same screen state it can restore. In a development build it reloads the bundle instead. */
export async function restartApp(): Promise<void> {
  if (__DEV__) {
    DevSettings.reload();
    return;
  }
  await Updates.reloadAsync();
}
