import { Platform } from "react-native";
import { messageOf, tagTokenOf, uidOf, uriOfMessage, type TagRecord } from "#src/nfc/tag.ts";

type NfcModule = typeof import("react-native-nfc-manager");

let loading: Promise<NfcModule | null> | undefined;

/**
 * The NFC module, started, or null on a phone without NFC, on the web, or in a build made before the module was added
 * (its import throws there). Loaded once, only when a screen asks (ADR-237), so nothing else ever touches it.
 */
export function nfcModule(): Promise<NfcModule | null> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return Promise.resolve(null);
  }
  loading ??= import("react-native-nfc-manager")
    .then(async (module) => {
      if (!(await module.default.isSupported())) {
        return null;
      }
      await module.default.start();
      return module;
    })
    .catch(() => null);
  return loading;
}

/** What a read of a tag gave: its URL (null when it holds no single URI record) and the sticker's id. */
export type TagRead =
  | Readonly<{ kind: "read"; url: string | null; uid: string | null }>
  | Readonly<{ kind: "cancelled" | "failed" | "unsupported" }>;

const isCancel = (module: NfcModule, error: unknown): boolean =>
  error instanceof module.NfcError.UserCancel;

/**
 * Starts one tag session: Android's reader mode (the tag never opens the browser while the screen waits), iOS's system
 * sheet with `alert`. The iPhone asks for MIFARE too, so Core NFC hands over the sticker's id (CTO 2). The session is
 * always closed after `work`.
 */
async function session<T>(
  alert: string,
  work: (module: NfcModule) => Promise<T>,
  failed: (cancelled: boolean) => T,
): Promise<T> {
  const module = await nfcModule();
  if (module === null) {
    return failed(false);
  }
  const { default: manager, NfcTech } = module;
  try {
    await manager.requestTechnology(
      Platform.OS === "ios" ? [NfcTech.Ndef, NfcTech.MifareIOS] : NfcTech.Ndef,
      { alertMessage: alert },
    );
    return await work(module);
  } catch (error) {
    return failed(isCancel(module, error));
  } finally {
    await manager.cancelTechnologyRequest().catch(() => undefined);
  }
}

/** The connected tag's message, read again when the first answer had none (a MIFARE session on the iPhone). */
async function messageNow(module: NfcModule, first: unknown): Promise<readonly TagRecord[] | null> {
  if (Array.isArray(first)) {
    return first as TagRecord[];
  }
  const read = await module.default.ndefHandler.getNdefMessage();
  return (read?.ndefMessage as TagRecord[] | undefined) ?? null;
}

/** Reads one tag for a player's tap (FR-621). */
export async function readTag(alert: string): Promise<TagRead> {
  if ((await nfcModule()) === null) {
    return { kind: "unsupported" };
  }
  return session<TagRead>(
    alert,
    async (module) => {
      const tag = await module.default.getTag();
      return {
        kind: "read",
        url: uriOfMessage(await messageNow(module, tag?.ndefMessage)),
        uid: uidOf(tag?.id),
      };
    },
    (cancelled) => ({ kind: cancelled ? "cancelled" : "failed" }),
  );
}

/** What a write gave: the sticker's id, or why nothing was written (FR-312). */
export type TagWrite =
  | Readonly<{ kind: "written"; uid: string }>
  | Readonly<{ kind: "locked" | "taken" | "cancelled" | "failed" | "unsupported" }>;

/**
 * Writes `url` on a tag (FR-312): refuses a locked tag, and a tag holding a Questify tag URL unless `rewrite`; writes
 * one URI record, reads it back, locks the tag when asked, and answers the sticker's id. Any failure leaves the
 * operator to tap again; nothing is stored until the API confirms.
 */
export async function writeTag(
  request: Readonly<{
    url: string;
    lock: boolean;
    rewrite: boolean;
    alert: string;
    extraOrigin: string | null;
  }>,
): Promise<TagWrite> {
  if ((await nfcModule()) === null) {
    return { kind: "unsupported" };
  }
  return session<TagWrite>(
    request.alert,
    async (module) => {
      const { default: manager, NdefStatus } = module;
      const tag = await manager.getTag();
      const uid = uidOf(tag?.id);
      const status = await manager.ndefHandler.getNdefStatus();
      if (status.status === NdefStatus.ReadOnly) {
        return { kind: "locked" };
      }
      const bytes = messageOf(request.url);
      if (
        uid === null ||
        status.status !== NdefStatus.ReadWrite ||
        status.capacity < bytes.length
      ) {
        return { kind: "failed" };
      }
      const before = uriOfMessage(await messageNow(module, tag?.ndefMessage));
      if (!request.rewrite && tagTokenOf(before, request.extraOrigin) !== null) {
        return { kind: "taken" };
      }
      await manager.ndefHandler.writeNdefMessage(bytes);
      const after = await manager.ndefHandler.getNdefMessage();
      if (uriOfMessage((after?.ndefMessage as TagRecord[] | undefined) ?? null) !== request.url) {
        return { kind: "failed" };
      }
      if (request.lock) {
        await manager.ndefHandler.makeReadOnly();
      }
      return { kind: "written", uid };
    },
    (cancelled) => ({ kind: cancelled ? "cancelled" : "failed" }),
  );
}

/** Ends a waiting session (the scanner closing, or the screen leaving). */
export async function stopReading(): Promise<void> {
  const module = await nfcModule();
  await module?.default.cancelTechnologyRequest().catch(() => undefined);
}
