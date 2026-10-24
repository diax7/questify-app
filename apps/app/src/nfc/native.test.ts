import { beforeEach, describe, expect, it, vi } from "vitest";
import { messageOf } from "#src/nfc/tag.ts";

const platform = vi.hoisted(() => ({ OS: "android" }));
vi.mock("react-native", () => ({ Platform: platform }));

class UserCancel extends Error {}
type Registration = Readonly<{ isReaderModeEnabled?: boolean; readerModeFlags?: number }>;
type Waiting = Readonly<{
  techs: readonly string[];
  resolve: (tech: string | null) => void;
  reject: (error: unknown) => void;
}>;

/**
 * react-native-nfc-manager 4.1.0's Android JS layer as it behaves: `requestTechnology` registers the tag event itself
 * when nothing is registered (foreground dispatch unless reader mode is asked) and then `cancelTechnologyRequest`
 * unregisters it after a delay. A tag reaches the app only while a registration with reader mode holds the reader;
 * otherwise Android dispatches it ("Could not find an app that supports this NFC tag" for a Questify sticker).
 */
const fake = vi.hoisted(() => ({
  enabled: true,
  registration: null as Registration | null,
  implicit: false,
  waiting: null as Waiting | null,
  tag: { id: "04a1b2c3d4e5f6", ndefMessage: [] as unknown[] },
  calls: [] as string[],
  formatted: null as null | { bytes: number[]; readOnly: boolean },
  written: null as number[] | null,
  /** The tag leaves the phone right after the write went through. */
  pulled: false,
  lockable: true,
}));

const manager = {
  isSupported: async () => true,
  start: async () => undefined,
  isEnabled: async () => fake.enabled,
  registerTagEvent: async (options: Registration) => {
    fake.calls.push("register");
    fake.registration = options;
  },
  unregisterTagEvent: async () => {
    fake.calls.push("unregister");
    fake.registration = null;
  },
  requestTechnology: (techs: string | string[], options: Registration = {}) => {
    if (fake.registration === null) {
      fake.registration = options;
      fake.implicit = true;
    }
    return new Promise<string | null>((resolve, reject) => {
      fake.waiting = { techs: typeof techs === "string" ? [techs] : techs, resolve, reject };
    });
  },
  cancelTechnologyRequest: async () => {
    fake.waiting?.reject(new UserCancel());
    fake.waiting = null;
    if (fake.implicit) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      fake.registration = null;
      fake.implicit = false;
    }
  },
  getTag: async () => fake.tag,
  ndefHandler: {
    getNdefStatus: async () => ({ status: 2, capacity: 137 }),
    getNdefMessage: async () => {
      if (fake.pulled && fake.written !== null) {
        throw new Error("Tag was lost.");
      }
      return { ndefMessage: fake.tag.ndefMessage };
    },
    writeNdefMessage: async (bytes: number[]) => {
      fake.written = bytes;
      fake.tag.ndefMessage = [{ tnf: 1, type: "U", payload: bytes.slice(4) }];
    },
    makeReadOnly: async () => {
      if (fake.pulled) {
        throw new Error("Tag was lost.");
      }
      return fake.lockable;
    },
  },
  ndefFormatableHandlerAndroid: {
    formatNdef: async (bytes: number[], options: { readOnly: boolean }) => {
      fake.formatted = { bytes, readOnly: options.readOnly };
    },
  },
};

vi.mock("react-native-nfc-manager", () => ({
  default: manager,
  NfcTech: { Ndef: "Ndef", NdefFormatable: "NdefFormatable", MifareIOS: "mifare" },
  NdefStatus: { NotSupported: 1, ReadWrite: 2, ReadOnly: 3 },
  NfcAdapter: {
    FLAG_READER_NFC_A: 1,
    FLAG_READER_NFC_B: 2,
    FLAG_READER_NFC_F: 4,
    FLAG_READER_NFC_V: 8,
  },
  NfcError: { UserCancel },
}));

/** A sticker held to the phone: answered by the app when reader mode holds the reader, else by Android. */
function holdTag(tech: string | null): "app" | "android" {
  const waiting = fake.waiting;
  if (fake.registration?.isReaderModeEnabled !== true || waiting === null) {
    return "android";
  }
  waiting.resolve(tech !== null && waiting.techs.includes(tech) ? tech : null);
  return "app";
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (check: () => boolean) => {
  for (let tries = 0; tries < 100 && !check(); tries += 1) {
    await settle();
  }
};
const URL = "https://questify.nafes.com/t/abc";
const request = { url: URL, lock: true, rewrite: false, alert: "Hold", extraOrigin: null };

async function load() {
  vi.resetModules();
  return import("#src/nfc/native.ts");
}

beforeEach(() => {
  platform.OS = "android";
  Object.assign(fake, {
    enabled: true,
    registration: null,
    implicit: false,
    waiting: null,
    tag: { id: "04a1b2c3d4e5f6", ndefMessage: [] },
    calls: [],
    formatted: null,
    written: null,
    pulled: false,
    lockable: true,
  });
});

describe("Android tag sessions", () => {
  it("holds the reader in reader mode for every tag kind while the write screen waits", async () => {
    const { writeTag } = await load();
    const written = writeTag(request);
    await until(() => fake.waiting !== null);
    expect(fake.registration).toMatchObject({ isReaderModeEnabled: true, readerModeFlags: 15 });
    expect(fake.waiting?.techs).toEqual(["Ndef", "NdefFormatable"]);
    expect(holdTag("Ndef")).toBe("app");
    expect(await written).toEqual({ kind: "written", uid: "04a1b2c3d4e5f6", locked: true });
    expect(fake.written).toEqual(messageOf(URL));
    expect(fake.registration).toBeNull();
  });

  it("formats a factory-blank sticker with the message, locked as asked", async () => {
    const { writeTag } = await load();
    const written = writeTag({ ...request, lock: false });
    await until(() => fake.waiting !== null);
    expect(holdTag("NdefFormatable")).toBe("app");
    expect(await written).toEqual({ kind: "written", uid: "04a1b2c3d4e5f6", locked: false });
    expect(fake.formatted).toEqual({ bytes: messageOf(URL), readOnly: false });
    expect(fake.written).toBeNull();
  });

  it("answers a tag pulled away after the write as written and unlocked, so its link gets registered", async () => {
    fake.pulled = true;
    const { writeTag } = await load();
    const written = writeTag(request);
    await until(() => fake.waiting !== null);
    holdTag("Ndef");
    expect(await written).toEqual({ kind: "written", uid: "04a1b2c3d4e5f6", locked: false });
    expect(fake.written).toEqual(messageOf(URL));
  });

  it("answers unlocked when the tag refuses the lock", async () => {
    fake.lockable = false;
    const { writeTag } = await load();
    const written = writeTag(request);
    await until(() => fake.waiting !== null);
    holdTag("Ndef");
    expect(await written).toEqual({ kind: "written", uid: "04a1b2c3d4e5f6", locked: false });
  });

  it("fails a write whose read-back shows another message", async () => {
    const { writeTag } = await load();
    const original = manager.ndefHandler.writeNdefMessage;
    manager.ndefHandler.writeNdefMessage = async () => undefined;
    const written = writeTag(request);
    await until(() => fake.waiting !== null);
    holdTag("Ndef");
    expect(await written).toEqual({ kind: "failed" });
    manager.ndefHandler.writeNdefMessage = original;
  });

  it("says a tag with neither NDEF nor a blank NDEF area cannot be used, in the app", async () => {
    const { writeTag } = await load();
    const written = writeTag(request);
    await until(() => fake.waiting !== null);
    expect(holdTag("MifareClassic")).toBe("app");
    expect(await written).toEqual({ kind: "unusable" });
    expect(fake.written).toBeNull();
  });

  it("keeps reading when the scanner restarts: the old session never turns the reader off under the new one", async () => {
    const { readTag, stopReading } = await load();
    const first = readTag("Hold");
    await until(() => fake.waiting !== null);
    void stopReading();
    const second = readTag("Hold");
    expect(await first).toEqual({ kind: "cancelled" });
    await until(() => fake.waiting !== null);
    await new Promise((resolve) => setTimeout(resolve, 40));
    fake.tag.ndefMessage = [{ tnf: 1, type: "U", payload: messageOf(URL).slice(4) }];
    expect(holdTag("Ndef")).toBe("app");
    expect(await second).toEqual({ kind: "read", url: URL, uid: "04a1b2c3d4e5f6" });
  });

  it("never starts a session that was stopped while it waited its turn", async () => {
    const { readTag, stopReading } = await load();
    const first = readTag("Hold");
    const second = readTag("Hold");
    await until(() => fake.waiting !== null);
    await stopReading();
    expect(await first).toEqual({ kind: "cancelled" });
    expect(await second).toEqual({ kind: "cancelled" });
    expect(fake.calls).toEqual(["register", "unregister"]);
  });

  it("answers off without waiting when NFC is switched off in settings", async () => {
    fake.enabled = false;
    const { readTag, writeTag } = await load();
    expect(await readTag("Hold")).toEqual({ kind: "off" });
    expect(await writeTag(request)).toEqual({ kind: "off" });
    expect(fake.calls).toEqual([]);
  });
});

describe("iPhone tag sessions", () => {
  it("opens the system sheet asking for NDEF and MIFARE, with no Android reader mode", async () => {
    platform.OS = "ios";
    const { readTag } = await load();
    const read = readTag("Hold");
    await until(() => fake.waiting !== null);
    expect(fake.waiting?.techs).toEqual(["Ndef", "mifare"]);
    expect(fake.calls).toEqual([]);
    fake.waiting?.resolve("Ndef");
    expect(await read).toEqual({ kind: "read", url: null, uid: "04a1b2c3d4e5f6" });
  });
});
