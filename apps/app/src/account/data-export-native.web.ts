import type { FileModules } from "#src/account/data-export.ts";
import { browser } from "#src/platform/browser.ts";

/**
 * The browser's version of the data download (T-803): the file is a Blob, saved with a download link, and its object
 * URL is revoked afterwards. There is no file system and no share sheet, and nothing is uploaded or kept.
 */
export const dataModulesPresent = (): boolean => {
  const env = browser();
  return env.Blob !== undefined && env.URL !== undefined && env.document !== undefined;
};

/** Names of the files made so far by object URL, so `share` can name the download. */
const NAMES = new Map<string, string>();

export function loadDataModules(): FileModules {
  const env = browser();
  return {
    writeCacheFile: (name, text) => {
      if (env.Blob === undefined || env.URL === undefined) {
        throw new Error("This browser cannot save a file.");
      }
      const uri = env.URL.createObjectURL(new env.Blob([text], { type: "application/json" }));
      NAMES.set(uri, name);
      return uri;
    },
    share: (uri) => {
      const doc = env.document;
      if (doc === undefined) {
        return Promise.reject(new Error("This browser cannot save a file."));
      }
      const link = doc.createElement("a");
      link.href = uri;
      link.download = NAMES.get(uri) ?? "questify-data.json";
      link.style.display = "none";
      doc.body.appendChild(link);
      link.click();
      link.remove();
      return Promise.resolve();
    },
    remove: (uri) => {
      NAMES.delete(uri);
      // The browser starts the download on the click; revoking in the next turn leaves it the URL it needs.
      setTimeout(() => env.URL?.revokeObjectURL(uri), 1000);
    },
  };
}
