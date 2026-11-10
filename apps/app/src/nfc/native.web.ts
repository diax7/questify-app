import type { TagRead, TagWrite } from "#src/nfc/native.ts";

/**
 * NFC in the browser (T-803): none. Web NFC is Chrome on Android alone and is not used, so `react-native-nfc-manager`
 * is never part of the web bundle. Every screen already hides its NFC entry points when `nfcModule` answers null.
 */
export const nfcModule = (): Promise<null> => Promise.resolve(null);

export const readTag = (_alert: string): Promise<TagRead> =>
  Promise.resolve({ kind: "unsupported" });

export const writeTag = (_request: unknown): Promise<TagWrite> =>
  Promise.resolve({ kind: "unsupported" });

export const stopReading = (): Promise<void> => Promise.resolve();
