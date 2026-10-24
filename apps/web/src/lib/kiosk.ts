import type { MessageKey } from "@questify/shared";
import type { PostResult } from "#src/lib/post-json.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";

/** The decoder's wasm, self-hosted with its version in the name so a long cache never serves a stale one (ADR-245). */
export const ZXING_WASM_PATH = "/zxing/zxing_reader-3.1.5.wasm";
/** How long a result card stays up. */
export const KIOSK_CARD_MS = 4000;
/** A code just sent is not sent again for this long: one held-up phone is one scan. */
export const KIOSK_DROP_MS = 5000;
/** Frames decoded a second, and the longest side a frame is scaled to before decoding. */
export const KIOSK_FRAME_MS = 250;
export const KIOSK_FRAME_MAX_PX = 640;
/** How long "Paused for a moment" stays after a 429 when the answer names no wait. */
const SLOWED_MS = 5000;
/** How long a send waits when the API is still answering the same key (409 request_in_progress), before asking again. */
export const KIOSK_IN_PROGRESS_WAIT_MS = 1000;

/** Whether a decoded string looks like a Questify code (43 to 60 base64url characters); anything else is never sent. */
export const looksLikeQuestifyCode = (text: string): boolean => /^[A-Za-z0-9_-]{43,60}$/.test(text);

export type KioskPlayer = Readonly<{ username: string; avatar: string }>;

/** What the kiosk shows for 4 seconds after a scan: green, orange, or red with the reason and no one named. */
export type KioskCard =
  | Readonly<{ kind: "paid"; player: KioskPlayer | null; points: number; boosted: boolean }>
  | Readonly<{ kind: "already"; player: KioskPlayer | null }>
  | Readonly<{ kind: "refused"; reason: string }>
  /** The API took the scan but had not answered it yet: neutral, never "Reconnecting…" for a player maybe paid. */
  | Readonly<{ kind: "received" }>;

/** What one scan led to: a card, or the page's state (unpaired starts over; slowed, offline and off are banners). */
export type KioskOutcome =
  | Readonly<{ kind: "card"; card: KioskCard }>
  | Readonly<{ kind: "unpaired" }>
  | Readonly<{ kind: "slowed"; forMs: number }>
  | Readonly<{ kind: "reconnecting" }>
  | Readonly<{ kind: "off" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const playerOf = (value: unknown): KioskPlayer | null =>
  isRecord(value) && typeof value["username"] === "string"
    ? {
        username: value["username"],
        avatar: typeof value["avatar"] === "string" ? value["avatar"] : "",
      }
    : null;

/** A scan's answer as a card, or undefined when it is not one of the three shapes. A red card never names anyone. */
export function kioskCardOf(body: unknown): KioskCard | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  switch (body["result"]) {
    case "completed":
      return typeof body["points"] === "number"
        ? {
            kind: "paid",
            player: playerOf(body["player"]),
            points: body["points"],
            boosted: body["boosted"] === true,
          }
        : undefined;
    case "already_completed":
      return { kind: "already", player: playerOf(body["player"]) };
    case "refused":
      return typeof body["reason"] === "string"
        ? { kind: "refused", reason: body["reason"] }
        : undefined;
    default:
      return undefined;
  }
}

const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  invalid_code: "kiosk.invalid",
  needs_live_code: "kiosk.needsLive",
  expired: "kiosk.expired",
  method_off: "kiosk.methodOff",
  not_in_event: "kiosk.notInEvent",
  not_open: "kiosk.notOpen",
  self_scan: "kiosk.selfScan",
  paused: "kiosk.paused",
};

/** The sentence a red card shows; an unknown reason reads as not open now. */
export const reasonKey = (reason: string): MessageKey => REASON_KEYS[reason] ?? "kiosk.notOpen";

const KIOSK_SHUT_KEYS: Readonly<Record<string, MessageKey>> = {
  paused: "kiosk.paused",
  method_off: "kiosk.methodOff",
  feature_off: "device.notAvailable",
};

/** The sentence a shut kiosk shows instead of the camera, or undefined for the station's shared ones. */
export const kioskShutKey = (shut: string): MessageKey | undefined => KIOSK_SHUT_KEYS[shut];

const retryAfterMs = (body: unknown): number => {
  const details = isRecord(body) && isRecord(body["details"]) ? body["details"] : {};
  const seconds = Number(details["retryAfterSeconds"]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : SLOWED_MS;
};

/** One answer of `POST /v1/device/kiosk-scans` as what the page does next. */
export function outcomeOf(result: PostResult): KioskOutcome {
  const code = errorCodeOf(result.body);
  if (code === "device_unpaired") {
    return { kind: "unpaired" };
  }
  if (code === "too_many_attempts") {
    return { kind: "slowed", forMs: retryAfterMs(result.body) };
  }
  if (code === "feature_off") {
    return { kind: "off" };
  }
  const card = result.ok ? kioskCardOf(result.body) : undefined;
  return card === undefined ? { kind: "reconnecting" } : { kind: "card", card };
}

export type KioskReaderDeps = Readonly<{
  /** Sends one code with its Idempotency-Key; a dropped connection is not ok with no body. */
  send: (code: string, key: string) => Promise<PostResult>;
  newKey: () => string;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  onOutcome: (outcome: KioskOutcome) => void;
}>;

/**
 * What the kiosk does with each string its decoder reads (T-309b): anything not shaped like a Questify code shows
 * "This isn't a Questify code" and is never sent; a string just read is dropped for 5 seconds; one scan is in flight at a
 * time, and the newest string read meanwhile waits for it. A send that fails on the network is retried once with the
 * same key, then the page says "Reconnecting…". An answer still in progress for that key (the first try reached the API)
 * is asked once more after a second with the same key, then shown as a neutral "Scan received" card. Nothing is ever
 * queued past that: a scan not sent is dropped.
 */
export function createKioskReader(
  deps: KioskReaderDeps,
): Readonly<{ read: (text: string) => void }> {
  const recent = new Map<string, number>();
  let inFlight = false;
  let waiting: string | undefined;

  const fresh = (text: string): boolean => {
    const now = deps.now();
    for (const [seen, at] of recent) {
      if (now - at >= KIOSK_DROP_MS) {
        recent.delete(seen);
      }
    }
    if (recent.has(text)) {
      return false;
    }
    recent.set(text, now);
    return true;
  };

  const sendOne = async (text: string): Promise<void> => {
    const key = deps.newKey();
    let result = await deps.send(text, key);
    if (!result.ok && result.body === undefined) {
      result = await deps.send(text, key);
    }
    if (errorCodeOf(result.body) === "request_in_progress") {
      await deps.wait(KIOSK_IN_PROGRESS_WAIT_MS);
      result = await deps.send(text, key);
      if (errorCodeOf(result.body) === "request_in_progress") {
        deps.onOutcome({ kind: "card", card: { kind: "received" } });
        return;
      }
    }
    deps.onOutcome(outcomeOf(result));
  };

  const read = (text: string): void => {
    if (inFlight) {
      waiting = text;
      return;
    }
    if (!fresh(text)) {
      return;
    }
    if (!looksLikeQuestifyCode(text)) {
      deps.onOutcome({ kind: "card", card: { kind: "refused", reason: "invalid_code" } });
      return;
    }
    inFlight = true;
    void sendOne(text).finally(() => {
      inFlight = false;
      const next = waiting;
      waiting = undefined;
      if (next !== undefined) {
        read(next);
      }
    });
  };

  return { read };
}

type Decoded = ReadonlyArray<Readonly<{ text: string; isValid: boolean }>>;

/**
 * The frame decoder (ADR-245): `load` brings up the reader and its wasm once. A load that fails is reported once
 * (`onFailed`) and every later frame is skipped, so a live camera never silently stops scanning; a frame the reader
 * cannot read is just no code.
 */
export function createDecoder<I>(
  load: () => Promise<(image: I) => Promise<Decoded>>,
  onFailed: (error: unknown) => void,
): Readonly<{ failed: () => boolean; read: (image: I) => Promise<string | undefined> }> {
  let failed = false;
  const reader = load().catch((error: unknown) => {
    failed = true;
    onFailed(error);
    return undefined;
  });
  return {
    failed: () => failed,
    read: async (image) => {
      const read = await reader;
      if (read === undefined) {
        return undefined;
      }
      const results = await read(image).catch((): Decoded => []);
      const text = results.find((result) => result.isValid)?.text;
      return text === undefined || text === "" ? undefined : text;
    },
  };
}

/** The size a video frame is drawn at before decoding: its own, scaled so its longest side is at most 640 pixels. */
export function frameSize(
  width: number,
  height: number,
): Readonly<{ width: number; height: number }> {
  const longest = Math.max(width, height);
  if (longest <= KIOSK_FRAME_MAX_PX || longest === 0) {
    return { width, height };
  }
  const scale = KIOSK_FRAME_MAX_PX / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** The camera the kiosk opens: the front one by default (a tablet on a stand faces the player), or the back one. */
export type Facing = "user" | "environment";

const FACING_KEY = "questify.kiosk.facing";

/** The camera this browser was switched to, remembered per device; the front one when nothing is stored or readable. */
export function storedFacing(storage: Pick<Storage, "getItem"> | undefined): Facing {
  try {
    return storage?.getItem(FACING_KEY) === "environment" ? "environment" : "user";
  } catch {
    return "user";
  }
}

/** Remembers the camera; a browser that refuses storage keeps the choice for this visit only. */
export function storeFacing(storage: Pick<Storage, "setItem"> | undefined, facing: Facing): void {
  try {
    storage?.setItem(FACING_KEY, facing);
  } catch {
    // Storage refused (a private window): the choice lasts until the page reloads.
  }
}
