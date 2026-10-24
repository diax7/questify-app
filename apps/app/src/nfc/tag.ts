import { QUEST_CODE_HOSTS } from "@questify/shared";
import { decodeBase64Url } from "#src/event/scan.ts";

/** An NFC tag's token (T-308, ADR-234): the layout of a quest code, format 0x06, the tag's own id. */
const FORMAT_TAG = 0x06;
/** `https://{host}/t/{token}` and nothing more: no query, no fragment, no trailing path (trailing data refused). */
const TAG_URL = /^https:\/\/([A-Za-z0-9.-]+)\/t\/([A-Za-z0-9_-]{50})$/;
/** The NDEF URI record's "https://" prefix code (NFC Forum URI RTD), the one this app writes. */
const HTTPS_PREFIX = 0x04;
const URI_TYPE = 0x55;
const WELL_KNOWN = 0x01;

/**
 * The token of a Questify tag's URL on a Questify host (or this build's one extra origin), or null for anything else.
 * The server's signature decides every tag; this only spares a call for someone else's sticker.
 */
export function tagTokenOf(url: string | null, extraOrigin: string | null): string | null {
  const match = url === null ? null : TAG_URL.exec(url);
  if (match === null) {
    return null;
  }
  const host = (match[1] ?? "").toLowerCase();
  if (!QUEST_CODE_HOSTS.includes(host) && `https://${host}` !== extraOrigin) {
    return null;
  }
  const token = match[2] ?? "";
  const bytes = decodeBase64Url(token);
  return bytes !== null && bytes.length === 37 && bytes[0] === FORMAT_TAG ? token : null;
}

/** One NDEF record as react-native-nfc-manager gives it: Android sends the type as text, iOS as bytes. */
export type TagRecord = Readonly<{
  tnf: number;
  type: readonly number[] | string;
  payload: readonly number[];
}>;

const isUriType = (type: readonly number[] | string): boolean =>
  typeof type === "string" ? type === "U" : type.length === 1 && type[0] === URI_TYPE;

/** Printable ASCII only: a Questify URL never needs more, and anything else is not ours. */
const asciiOf = (bytes: readonly number[]): string | null =>
  bytes.every((byte) => byte > 0x20 && byte < 0x7f) ? String.fromCharCode(...bytes) : null;

/**
 * The URL of a tag's message when it is exactly one URI record, written plain or with the "https://" prefix code;
 * null for an empty tag, several records, another kind of record or any other prefix.
 */
export function uriOfMessage(records: readonly TagRecord[] | null | undefined): string | null {
  if (records === null || records === undefined || records.length !== 1) {
    return null;
  }
  const record = records[0] as TagRecord;
  if (record.tnf !== WELL_KNOWN || !isUriType(record.type) || record.payload.length < 2) {
    return null;
  }
  const [prefix, ...rest] = record.payload;
  const text = asciiOf(rest);
  if (text === null || (prefix !== 0 && prefix !== HTTPS_PREFIX)) {
    return null;
  }
  return prefix === HTTPS_PREFIX ? `https://${text}` : text;
}

/**
 * The bytes of a one-record NDEF message holding `url` (an https URL), as `writeNdefMessage` takes them: a short
 * record (MB, ME, SR, TNF well-known), type "U", the "https://" prefix code, then the rest of the URL.
 *
 * @throws Error when the URL is not https or too long for a short record.
 */
export function messageOf(url: string): number[] {
  if (!url.startsWith("https://")) {
    throw new Error(`Not an https URL: ${url}`);
  }
  const rest = Array.from(url.slice("https://".length), (character) => character.charCodeAt(0));
  const payload = [HTTPS_PREFIX, ...rest];
  if (payload.length > 255 || asciiOf(rest) === null) {
    throw new Error("The URL does not fit one short NDEF record.");
  }
  return [0xd1, 1, payload.length, URI_TYPE, ...payload];
}

/**
 * A sticker's id as lower-case hex (4 to 10 bytes), from the hex text Android and iOS give (with or without
 * separators, either case) or from bytes; null when there is none or it is not one. Both platforms give the bytes in
 * the order the tag sends them, so one sticker reads the same on both.
 */
export function uidOf(id: unknown): string | null {
  let hex: string | null = null;
  if (typeof id === "string") {
    hex = id.replaceAll(/[\s:-]/g, "").toLowerCase();
  } else if (
    Array.isArray(id) &&
    id.every((byte) => Number.isInteger(byte) && byte >= 0 && byte < 256)
  ) {
    hex = id.map((byte: number) => byte.toString(16).padStart(2, "0")).join("");
  }
  return hex !== null && /^(?:[0-9a-f]{2}){4,10}$/.test(hex) ? hex : null;
}
