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
  shareText: (message) => {
    const share = browser().navigator?.share;
    return share === undefined
      ? Promise.reject(new Error("Sharing is not available."))
      : share({ text: message });
  },
};
