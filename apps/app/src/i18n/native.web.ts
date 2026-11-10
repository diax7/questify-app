import { getLocales } from "expo-localization";
import type { Language } from "@questify/shared";
import type { DeviceLocale } from "#src/i18n/language.ts";
import { isRtl } from "#src/i18n/language.ts";
import { browser } from "#src/platform/browser.ts";

/**
 * Layout direction in the browser (T-803). react-native-web does not honour `I18nManager`, so the direction lives on
 * `<html dir lang>`, which a page load forgets: the last chosen language is kept under this key (a language code, no
 * personal data) and put back on `<html>` as soon as this file loads, before the first screen draws.
 */
export const DIRECTION_KEY = "questify.web.language";

const readStored = (): Language => {
  try {
    return browser().localStorage?.getItem(DIRECTION_KEY) === "ar" ? "ar" : "en";
  } catch {
    return "en";
  }
};

/** Sets `dir` and `lang` on `<html>`: Arabic is right to left, English left to right. */
export function setDocumentDirection(language: Language, doc = browser().document): void {
  if (doc !== undefined) {
    doc.documentElement.dir = isRtl(language) ? "rtl" : "ltr";
    doc.documentElement.lang = language;
  }
}

setDocumentDirection(readStored());

/** The phone's languages, most preferred first (`expo-localization` reads `navigator.languages`). */
export function deviceLocales(): readonly DeviceLocale[] {
  return getLocales();
}

/** The direction the page started with. */
export function layoutIsRtl(): boolean {
  return browser().document?.documentElement.dir === "rtl";
}

/** Remembers the language, so the next page load starts with its `dir` and `lang`, and sets them now. */
export function applyDirectionForNextLaunch(language: Language): void {
  try {
    browser().localStorage?.setItem(DIRECTION_KEY, language);
  } catch {
    // Storage may be blocked (a private window): the page still takes the direction below until it reloads.
  }
  setDocumentDirection(language);
}

/** A page reload is the browser's restart (ADR-101): the whole page then draws in the new direction. */
export function restartApp(): Promise<void> {
  browser().location?.reload();
  // The page is going away; never settle, so nothing runs after the reload has begun.
  return new Promise<void>(() => undefined);
}
