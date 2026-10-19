import type { Language } from "@questify/shared";

/** The part of AsyncStorage the app uses. */
export type KeyValueStorage = Readonly<{
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}>;

export const LANGUAGE_KEY = "questify.language";

/**
 * The saved language choice, exactly as stored (it is checked where it is used). An unreadable store counts as
 * "no choice yet", so the app starts in the phone's language instead of not starting.
 */
export async function loadStoredLanguage(storage: KeyValueStorage): Promise<string | null> {
  try {
    return await storage.getItem(LANGUAGE_KEY);
  } catch {
    return null;
  }
}

/** Saves the player's choice. Throws if it cannot be saved, so the switch is not reported as done. */
export async function saveLanguage(storage: KeyValueStorage, language: Language): Promise<void> {
  await storage.setItem(LANGUAGE_KEY, language);
}
