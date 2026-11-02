import { requireOptionalNativeModule } from "expo";
import type * as FileSystem from "expo-file-system";
import type * as Sharing from "expo-sharing";
import type { FileModules } from "#src/account/data-export.ts";

/**
 * The real file and share modules behind the data download (T-708). The registered native names are `FileSystem`
 * (`expo-file-system`) and `ExpoSharing`; `requireOptionalNativeModule` answers null for a module the build lacks,
 * where a plain import would throw as it loads (the recap share's pattern, ADR-339).
 */
export const dataModulesPresent = (): boolean =>
  requireOptionalNativeModule("FileSystem") != null &&
  requireOptionalNativeModule("ExpoSharing") != null;

/** Requires both packages; called only after `dataModulesPresent` answered true. */
export function loadDataModules(): FileModules {
  const files = require("expo-file-system") as typeof FileSystem;
  const sharing = require("expo-sharing") as typeof Sharing;
  return {
    writeCacheFile: (name, text) => {
      const file = new files.File(files.Paths.cache, name);
      if (file.exists) {
        file.delete();
      }
      file.create();
      file.write(text);
      return file.uri;
    },
    share: (uri) => sharing.shareAsync(uri, { mimeType: "application/json", UTI: "public.json" }),
    remove: (uri) => {
      const file = new files.File(uri);
      if (file.exists) {
        file.delete();
      }
    },
  };
}
