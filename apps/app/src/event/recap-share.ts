/**
 * Sharing the recap card (T-410b, ADR-339). The card is drawn into a PNG on the phone and handed to the system share
 * sheet; nothing is uploaded, and the image goes alone: no link, no tracking, no text line. Where the two native
 * modules are not in the build (an older development build), one fixed text line goes through React Native's own
 * `Share` instead.
 *
 * Loading `react-native-view-shot` or `expo-sharing` on a build without its native module throws when the package is
 * required (view-shot calls `TurboModuleRegistry.getEnforcing` as it loads), the class of crash the `toSorted` APK
 * had. So this file never imports either: `loadModules` is the only place they are required, and it runs only after
 * `modulesPresent` says both are there. The real checks live in `recap-share-native.ts`.
 */

/** The three calls the image path needs, as `react-native-view-shot` and `expo-sharing` give them. */
export type ImageShareModules = Readonly<{
  captureRef: (
    target: unknown,
    options: Readonly<{ format: "png"; quality: number; result: "tmpfile" }>,
  ) => Promise<string>;
  releaseCapture: (uri: string) => void;
  shareAsync: (
    uri: string,
    options: Readonly<{ mimeType: string; UTI: string; dialogTitle: string }>,
  ) => Promise<void>;
}>;

export type RecapShareDeps = Readonly<{
  /** True only when both native modules are in this build. */
  modulesPresent: () => boolean;
  /** Requires the two packages; called only after `modulesPresent` returned true. */
  loadModules: () => ImageShareModules;
  /** React Native's `Share` with one line of text. */
  shareText: (message: string) => Promise<unknown>;
}>;

/** How a share went: the card as an image, or the fixed line as text. A failure throws. */
export type ShareKind = "image" | "text";

export type RecapSharer = Readonly<{
  /** Captures `target` and opens the share sheet; `message` is only for the text path. */
  share: (
    target: unknown,
    texts: Readonly<{ message: string; dialogTitle: string }>,
  ) => Promise<ShareKind>;
  /** Deletes the last capture; the screen calls it when it closes. */
  release: () => void;
}>;

/**
 * A sharer for one screen. It keeps the last capture's file because the receiving app may still be reading it when the
 * share sheet returns; that file is released before the next capture and when the screen closes (`release`).
 */
export function createRecapSharer(deps: RecapShareDeps): RecapSharer {
  let modules: ImageShareModules | undefined;
  let last: string | undefined;

  const release = () => {
    if (modules !== undefined && last !== undefined) {
      modules.releaseCapture(last);
    }
    last = undefined;
  };

  const shareImage = async (
    target: unknown,
    dialogTitle: string,
    loaded: ImageShareModules,
  ): Promise<void> => {
    release();
    const uri = await loaded.captureRef(target, { format: "png", quality: 1, result: "tmpfile" });
    last = uri;
    await loaded.shareAsync(uri, { mimeType: "image/png", UTI: "public.png", dialogTitle });
  };

  /** The two packages, or undefined when they are not in this build or fail to load: the text path then. */
  const imageModules = (): ImageShareModules | undefined => {
    if (modules === undefined && deps.modulesPresent()) {
      try {
        modules = deps.loadModules();
      } catch {
        // The check said both were there but a package still failed to load: share the text line, never crash.
        return undefined;
      }
    }
    return modules;
  };

  return {
    share: async (target, texts) => {
      const loaded = imageModules();
      if (loaded === undefined) {
        await deps.shareText(texts.message);
        return "text";
      }
      await shareImage(target, texts.dialogTitle, loaded);
      return "image";
    },
    release,
  };
}
