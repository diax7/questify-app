/**
 * A small CBOR reader (RFC 8949) for the two Apple App Attest objects (T-812): unsigned and negative integers, byte and
 * text strings, arrays, maps with text or integer keys, false, true and null, all of definite length. Anything else
 * (tags, floats, indefinite lengths, nesting deeper than 8) is refused: Apple's objects never use it, so it can only
 * be a forged one. No dependency for 80 lines (rule 8).
 */

export type Cbor = number | Buffer | string | boolean | null | readonly Cbor[] | CborMap;
export type CborMap = ReadonlyMap<string | number, Cbor>;

/** The input is not a CBOR value this reader takes. Its message never quotes the input. */
export class CborError extends Error {
  constructor(reason: string) {
    super(`CBOR: ${reason}`);
    this.name = "CborError";
  }
}

const MAX_DEPTH = 8;

type Reader = { readonly bytes: Buffer; offset: number };

function take(reader: Reader, size: number): Buffer {
  if (size < 0 || reader.offset + size > reader.bytes.length) {
    throw new CborError("truncated");
  }
  const part = reader.bytes.subarray(reader.offset, reader.offset + size);
  reader.offset += size;
  return part;
}

/** The argument of the head whose low five bits are `info` (lengths up to 2^32: larger is refused). */
function argument(reader: Reader, info: number): number {
  if (info < 24) {
    return info;
  }
  if (info === 24) {
    return take(reader, 1).readUInt8(0);
  }
  if (info === 25) {
    return take(reader, 2).readUInt16BE(0);
  }
  if (info === 26) {
    return take(reader, 4).readUInt32BE(0);
  }
  throw new CborError("unsupported length");
}

function simple(info: number): boolean | null {
  if (info === 20) return false;
  if (info === 21) return true;
  if (info === 22) return null;
  throw new CborError("unsupported simple value");
}

function mapOf(reader: Reader, size: number, depth: number): CborMap {
  const map = new Map<string | number, Cbor>();
  for (let index = 0; index < size; index += 1) {
    const key = item(reader, depth + 1);
    if (typeof key !== "string" && typeof key !== "number") {
      throw new CborError("unsupported map key");
    }
    if (map.has(key)) {
      throw new CborError("repeated map key");
    }
    map.set(key, item(reader, depth + 1));
  }
  return map;
}

/** The reader of each major type 0 to 5, given the head's argument. */
const MAJORS: ReadonlyArray<(reader: Reader, value: number, depth: number) => Cbor> = [
  (_reader, value) => value,
  (_reader, value) => -1 - value,
  (reader, value) => Buffer.from(take(reader, value)),
  (reader, value) => take(reader, value).toString("utf8"),
  (reader, value, depth) => Array.from({ length: value }, () => item(reader, depth + 1)),
  (reader, value, depth) => mapOf(reader, value, depth),
];

function item(reader: Reader, depth: number): Cbor {
  if (depth > MAX_DEPTH) {
    throw new CborError("too deep");
  }
  const head = take(reader, 1).readUInt8(0);
  const major = head >> 5;
  const info = head & 0x1f;
  if (major === 7) {
    return simple(info);
  }
  const read = MAJORS[major];
  if (read === undefined) {
    throw new CborError("unsupported type");
  }
  return read(reader, argument(reader, info), depth);
}

/**
 * The one CBOR value in `bytes`.
 *
 * @throws CborError when it is not one whole value of the kinds above, or bytes follow it.
 */
export function decodeCbor(bytes: Buffer): Cbor {
  const reader: Reader = { bytes, offset: 0 };
  const value = item(reader, 0);
  if (reader.offset !== bytes.length) {
    throw new CborError("trailing bytes");
  }
  return value;
}

/** The map in `value`, else undefined. */
export const asMap = (value: Cbor | undefined): CborMap | undefined =>
  value instanceof Map ? (value as CborMap) : undefined;

/** The bytes in `value`, else undefined. */
export const asBytes = (value: Cbor | undefined): Buffer | undefined =>
  Buffer.isBuffer(value) ? value : undefined;
