import type { Language } from "@questify/shared";

/** The part of AsyncStorage the app uses. */
export type KeyValueStorage = Readonly<{
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}>;

export const LANGUAGE_KEY = "questify.language";
/** Which language the last restart was for, so a restart that did not take is not repeated forever. */
export const RESTART_KEY = "questify.restartTriedFor";

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

/** The language the last restart was for, or null. An unreadable store counts as none. */
export async function loadRestartNote(storage: KeyValueStorage): Promise<string | null> {
  try {
    return await storage.getItem(RESTART_KEY);
  } catch {
    return null;
  }
}

/** Notes, before restarting, which language the restart is for. Empty clears the note once a launch fits. */
export async function saveRestartNote(
  storage: KeyValueStorage,
  language: Language | "",
): Promise<void> {
  await storage.setItem(RESTART_KEY, language);
}
