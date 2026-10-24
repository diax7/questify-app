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
  | Readonly<{ kind: "cancelled" | "failed" | "unsupported" | "off" }>;

/** Why a session gave nothing: the person or the screen stopped it, it broke, or NFC is switched off in settings. */
type Stop = "cancelled" | "failed" | "off";

const isCancel = (module: NfcModule, error: unknown): boolean =>
  error instanceof module.NfcError.UserCancel;

/** The session before this one, so a new one starts only after the last one let go of the reader (ADR-243). */
let previous: Promise<unknown> = Promise.resolve();
/** Bumped by `stopReading`: a session that was waiting its turn when the screen stopped never starts. */
let generation = 0;

/**
 * Android's reader mode for every kind of tag (ADR-243): while a session waits, the phone hands each tag to this app,
 * so a tag never opens the browser or Android's "no app for this tag" message.
 */
const readerMode = (module: NfcModule, alert: string) => {
  const { FLAG_READER_NFC_A, FLAG_READER_NFC_B, FLAG_READER_NFC_F, FLAG_READER_NFC_V } =
    module.NfcAdapter;
  return {
    alertMessage: alert,
    isReaderModeEnabled: true,
    readerModeFlags: FLAG_READER_NFC_A | FLAG_READER_NFC_B | FLAG_READER_NFC_F | FLAG_READER_NFC_V,
  };
};

/**
 * Waits for one tag and connects to it, answering the technology it connected with (null when the tag has none of
 * them). Android: this app turns reader mode on itself and off when the session ends, so the library never turns it
 * off later under a newer session (ADR-243); a factory-blank sticker connects as NdefFormatable. iOS: the system sheet
 * with `alert`, asking for MIFARE too so Core NFC hands over the sticker's id (CTO 2).
 */
async function connect(module: NfcModule, alert: string): Promise<string | null> {
  const { default: manager, NfcTech } = module;
  if (Platform.OS === "ios") {
    return (await manager.requestTechnology([NfcTech.Ndef, NfcTech.MifareIOS], {
      alertMessage: alert,
    })) as string | null;
  }
  await manager.registerTagEvent(readerMode(module, alert));
  return (await manager.requestTechnology([NfcTech.Ndef, NfcTech.NdefFormatable])) as string | null;
}

/** Ends a session: the waiting request, then (Android) the reader mode this app turned on. */
async function release(module: NfcModule): Promise<void> {
  await module.default.cancelTechnologyRequest().catch(() => undefined);
  if (Platform.OS !== "ios") {
    await module.default.unregisterTagEvent().catch(() => undefined);
  }
}

/**
 * Runs one tag session, one at a time: refuses at once when NFC is switched off (Android), gives up when the screen
 * stopped reading while it waited its turn, and always lets go of the tag after `work`.
 */
async function session<T>(
  alert: string,
  work: (module: NfcModule, tech: string | null) => Promise<T>,
  failed: (stop: Stop) => T,
): Promise<T> {
  const turn = generation;
  const run = previous.then(async () => {
    const module = await nfcModule();
    if (module === null) {
      return failed("failed");
    }
    if (Platform.OS !== "ios" && !(await module.default.isEnabled().catch(() => true))) {
      return failed("off");
    }
    if (turn !== generation) {
      return failed("cancelled");
    }
    try {
      return await work(module, await connect(module, alert));
    } catch (error) {
      return failed(isCancel(module, error) ? "cancelled" : "failed");
    } finally {
      await release(module);
    }
  });
  previous = run.catch(() => undefined);
  return run;
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
    (stop) => ({ kind: stop }),
  );
}

/** What a write gave: the sticker's id, or why nothing was written (FR-312). */
export type TagWrite =
  | Readonly<{ kind: "written"; uid: string; locked: boolean }>
  | Readonly<{
      kind: "locked" | "taken" | "unusable" | "cancelled" | "failed" | "unsupported" | "off";
    }>;

type WriteRequest = Readonly<{
  url: string;
  lock: boolean;
  rewrite: boolean;
  alert: string;
  extraOrigin: string | null;
}>;

/**
 * Writes on a tag that already holds an NDEF area: refuses a locked tag, and a tag holding a Questify tag URL unless
 * `rewrite`; writes one URI record, reads it back, and locks it when asked. Once the write went through, only a
 * read-back showing another message fails it: a tag pulled away before the read-back or the lock is still answered as
 * written (unlocked), so the server registers the link it now holds instead of leaving it unknown (ADR-243).
 */
async function writeNdef(
  module: NfcModule,
  request: WriteRequest,
  uid: string,
  first: unknown,
): Promise<TagWrite> {
  const { default: manager, NdefStatus } = module;
  const status = await manager.ndefHandler.getNdefStatus();
  if (status.status === NdefStatus.ReadOnly) {
    return { kind: "locked" };
  }
  const bytes = messageOf(request.url);
  if (status.status !== NdefStatus.ReadWrite || status.capacity < bytes.length) {
    return { kind: "failed" };
  }
  const before = uriOfMessage(await messageNow(module, first));
  if (!request.rewrite && tagTokenOf(before, request.extraOrigin) !== null) {
    return { kind: "taken" };
  }
  await manager.ndefHandler.writeNdefMessage(bytes);
  const after = await manager.ndefHandler.getNdefMessage().catch(() => null);
  if (
    after !== null &&
    uriOfMessage((after?.ndefMessage as TagRecord[] | undefined) ?? null) !== request.url
  ) {
    return { kind: "failed" };
  }
  const locked =
    request.lock && (await manager.ndefHandler.makeReadOnly().catch(() => false)) === true;
  return { kind: "written", uid, locked };
}

/**
 * Writes `url` on a tag (FR-312) and answers the sticker's id. A factory-blank sticker (Android, no NDEF area yet) is
 * formatted with the message in one step, locked in the same step when asked; Android reports the format only when
 * the message was written (ADR-243). A tag with neither (a MIFARE Classic card on most phones) is `unusable`, said in
 * the app rather than left to Android. Any failure leaves the operator to tap again; nothing is stored until the API
 * confirms.
 */
export async function writeTag(request: WriteRequest): Promise<TagWrite> {
  if ((await nfcModule()) === null) {
    return { kind: "unsupported" };
  }
  return session<TagWrite>(
    request.alert,
    async (module, tech) => {
      const tag = await module.default.getTag();
      const uid = uidOf(tag?.id);
      if (uid === null) {
        return { kind: "failed" };
      }
      if (tech === null && Platform.OS !== "ios") {
        return { kind: "unusable" };
      }
      if (tech === module.NfcTech.NdefFormatable) {
        await module.default.ndefFormatableHandlerAndroid.formatNdef(messageOf(request.url), {
          readOnly: request.lock,
        });
        return { kind: "written", uid, locked: request.lock };
      }
      return writeNdef(module, request, uid, tag?.ndefMessage);
    },
    (stop) => ({ kind: stop }),
  );
}

/** Ends a waiting session (the scanner closing, or the screen leaving); a session still waiting its turn never starts. */
export async function stopReading(): Promise<void> {
  generation += 1;
  const module = await nfcModule();
  await module?.default.cancelTechnologyRequest().catch(() => undefined);
}
