import { QUEST_CODE_HOSTS, parseJoinLink } from "@questify/shared";

const DEV_QUEST_CODE_ORIGIN = "https://questify-web-staging-4ecphq.cranl.net";

/**
 * One more web origin whose printed quest codes this build reads, besides Questify's own (`QUEST_CODE_HOSTS`): staging
 * for a demo build (`EXPO_PUBLIC_QUEST_CODE_ORIGIN`), staging by default in development, none otherwise. The server's
 * signature decides every code; the host only spares the player a call for someone else's QR.
 *
 * @throws Error naming `EXPO_PUBLIC_QUEST_CODE_ORIGIN` when it is not an origin, or not https in a release build.
 */
export function questCodeOrigin(
  configured: string | undefined,
  development: boolean,
): string | null {
  if (configured === undefined || configured === "") {
    return development ? DEV_QUEST_CODE_ORIGIN : null;
  }
  // Checked by pattern, not `URL`: React Native's `URL` accepts anything.
  const origin = /^(https?):\/\/([A-Za-z0-9.-]+)\/?$/.exec(configured.trim());
  if (origin === null) {
    throw new Error(
      `EXPO_PUBLIC_QUEST_CODE_ORIGIN "${configured}" is not an origin like https://host.`,
    );
  }
  if (origin[1] !== "https" && !development) {
    throw new Error(
      `EXPO_PUBLIC_QUEST_CODE_ORIGIN must be https in a release build, not "${configured}".`,
    );
  }
  return `${origin[1]}://${(origin[2] ?? "").toLowerCase()}`;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding into bytes, or null for a character outside the alphabet. Hermes has no `Buffer`. */
export function decodeBase64Url(text: string): Uint8Array | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of text) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) {
      return null;
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** A printed quest code's token (ADR-116): 37 bytes, 50 base64url characters. */
const TOKEN = /^[A-Za-z0-9_-]{50}$/;
const FORMAT_QUEST = 0x01;
/** A printed passport step's code (T-304b, ADR-203): the same layout, the step's id. */
const FORMAT_STEP = 0x04;
/** A hidden category's secret code (T-304c, ADR-204): the same layout, the category's id. */
const FORMAT_REVEAL = 0x05;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The id inside a token of this format, read for the request's path only: the server verifies the whole token. */
function idOf(token: string, format: number): string | null {
  const bytes = TOKEN.test(token) ? decodeBase64Url(token) : null;
  if (bytes === null || bytes.length !== 37 || bytes[0] !== format) {
    return null;
  }
  const id = hex(bytes.subarray(1, 17));
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** The quest id inside a printed quest code's token. */
export const questIdOf = (token: string): string | null => idOf(token, FORMAT_QUEST);

/** The step id inside a printed passport step's token (T-304b). */
export const stepIdOf = (token: string): string | null => idOf(token, FORMAT_STEP);

/** The category id inside a hidden category's secret token (T-304c). */
export const categoryIdOf = (token: string): string | null => idOf(token, FORMAT_REVEAL);

export type Scan =
  | Readonly<{ kind: "quest"; questId: string; token: string }>
  | Readonly<{ kind: "step"; stepId: string; token: string }>
  | Readonly<{ kind: "reveal"; categoryId: string; token: string }>
  | Readonly<{ kind: "join"; code: string }>
  | Readonly<{ kind: "other" }>;

/**
 * An https link split by one pattern, the same on the phone and in tests: React Native's own `URL` never throws and
 * reads its parts with regular expressions, so a bare word must never reach it as a link.
 */
const HTTPS_LINK = /^https:\/\/([A-Za-z0-9.-]+)(\/[^?#\s]*)?(?:[?#]\S*)?$/;

/**
 * What the camera read: a quest, passport step or secret category code on a Questify host (`https://{host}/q/{token}`), a join link, or
 * something else.
 * Only whole https links count, never a bare word.
 */
export function readScan(text: string, extraOrigin: string | null): Scan {
  const trimmed = text.trim();
  const link = HTTPS_LINK.exec(trimmed);
  if (link === null) {
    return { kind: "other" };
  }
  const join = parseJoinLink(trimmed);
  if (join !== null) {
    return { kind: "join", code: join };
  }
  const host = (link[1] ?? "").toLowerCase();
  const known = QUEST_CODE_HOSTS.includes(host) || `https://${host}` === extraOrigin;
  const token = /^\/q\/([^/]+)\/?$/.exec(link[2] ?? "")?.[1];
  if (!known || token === undefined) {
    return { kind: "other" };
  }
  const questId = questIdOf(token);
  if (questId !== null) {
    return { kind: "quest", questId, token };
  }
  const stepId = stepIdOf(token);
  if (stepId !== null) {
    return { kind: "step", stepId, token };
  }
  const categoryId = categoryIdOf(token);
  return categoryId === null ? { kind: "other" } : { kind: "reveal", categoryId, token };
}

/**
 * The scanner's repeat guard: the camera reports the same code many times a second. While a scan is being answered,
 * nothing passes; an unrecognised code passes once (one message, one buzz) until the player scans again.
 */
export type ScanGate = Readonly<{ busy: boolean; ignored: string | null }>;

export const OPEN_GATE: ScanGate = { busy: false, ignored: null };

export function passes(gate: ScanGate, value: string): boolean {
  return !gate.busy && gate.ignored !== value;
}
