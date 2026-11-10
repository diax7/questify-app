import type { RecapShareDeps } from "#src/event/recap-share.ts";
import { browser } from "#src/platform/browser.ts";

/**
 * The browser's recap share (T-803): the image capture is hidden (`react-native-view-shot` and `expo-sharing` are not
 * loaded), so the sharer always takes its text path, and that uses `navigator.share` where the browser has it (phone
 * browsers do). Where it does not, `canShareRecap` is false and the screen hides the Share button.
 */
export const canShareRecap = (): boolean => typeof browser().navigator?.share === "function";

export const recapShareDeps: RecapShareDeps = {
  modulesPresent: () => false,
  loadModules: () => {
    throw new Error("The image share is not part of the web build.");
  },
  shareText: async (message) => {
    const nav = browser().navigator;
    if (nav?.share === undefined) throw new Error("Sharing is not available.");
    try {
      // Called on the navigator itself: a detached `share` throws "Illegal invocation" in a real browser.
      await nav.share({ text: message });
    } catch (error) {
      // The player closed the share sheet: the same quiet end as on a phone, not a failure.
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    }
  },
};
