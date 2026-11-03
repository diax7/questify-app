/** The part of AsyncStorage the intro needs. */
export type IntroStore = Readonly<{
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}>;

export const INTRO_KEY = "questify.intro";

/**
 * Where this install is in the intro (FR-1802): `fresh` (never shown), `language` (the language step is done and the app
 * may have restarted for it, so the cards come next) or `seen`. It is the only thing the intro keeps (FR-1800).
 */
export type IntroState = "fresh" | "language" | "seen";

/**
 * The stored state. A value this version does not know counts as fresh. A store that cannot be read counts as seen: a
 * broken store must never trap a player in an intro (the intro never blocks), and Settings can still replay it.
 */
export async function readIntroState(store: IntroStore): Promise<IntroState> {
  try {
    const stored = await store.getItem(INTRO_KEY);
    return stored === "seen" || stored === "language" ? stored : "fresh";
  } catch {
    return "seen";
  }
}

/** Whether the intro still has to be shown on this install. */
export const introDue = (state: IntroState): boolean => state !== "seen";

/**
 * Remembers the step. A write that fails is not an error for the player: the intro may then show once more on a later
 * launch, which is better than stopping them here.
 */
export async function writeIntroState(
  store: IntroStore,
  state: Exclude<IntroState, "fresh">,
): Promise<void> {
  try {
    await store.setItem(INTRO_KEY, state);
  } catch {
    // Deliberately ignored, see above.
  }
}
