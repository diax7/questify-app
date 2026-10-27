import { requireOptionalNativeModule } from "expo";
import { Share, TurboModuleRegistry } from "react-native";
import type * as ViewShot from "react-native-view-shot";
import type * as Sharing from "expo-sharing";
import type { ImageShareModules, RecapShareDeps } from "#src/event/recap-share.ts";

/**
 * The real checks and loads behind the recap share (ADR-339, plan review MAJOR 1). The registered native names are
 * `ExpoSharing` (both platforms' `SharingModule`) and `RNViewShot` (`react-native-view-shot`'s TurboModule spec).
 * `requireOptionalNativeModule` and `TurboModuleRegistry.get` answer null for a module the build lacks, where a plain
 * import of either package would throw as it loads.
 */
const modulesPresent = (): boolean =>
  requireOptionalNativeModule("ExpoSharing") != null &&
  TurboModuleRegistry.get("RNViewShot") != null;

/** Requires both packages. Only `createRecapSharer` calls it, and only after `modulesPresent` returned true. */
function loadModules(): ImageShareModules {
  const viewShot = require("react-native-view-shot") as typeof ViewShot;
  const sharing = require("expo-sharing") as typeof Sharing;
  return {
    captureRef: (target, options) =>
      viewShot.captureRef(target as Parameters<typeof viewShot.captureRef>[0], options),
    releaseCapture: viewShot.releaseCapture,
    shareAsync: sharing.shareAsync,
  };
}

export const recapShareDeps: RecapShareDeps = {
  modulesPresent,
  loadModules,
  shareText: (message) => Share.share({ message }),
};
