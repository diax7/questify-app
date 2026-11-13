/**
 * Just enough DER (X.690) to read one extension of an X.509 certificate (T-812): Node's `X509Certificate` checks the
 * chain and the dates but does not expose an extension it does not know, such as App Attest's nonce
 * (1.2.840.113635.100.8.2). Lengths up to 4 bytes; anything malformed throws.
 */

export type Der = Readonly<{ tag: number; value: Buffer }>;

/** The input is not the DER expected. Its message never quotes the input. */
export class DerError extends Error {
  constructor(reason: string) {
    super(`DER: ${reason}`);
    this.name = "DerError";
  }
}

/** The element at `offset` and where the next one starts. */
function element(bytes: Buffer, offset: number): Readonly<{ der: Der; next: number }> {
  if (offset + 2 > bytes.length) {
    throw new DerError("truncated");
  }
  const tag = bytes.readUInt8(offset);
  if ((tag & 0x1f) === 0x1f) {
    throw new DerError("long tags are not read");
  }
  const first = bytes.readUInt8(offset + 1);
  let start = offset + 2;
  let length = first;
  if (first & 0x80) {
    const size = first & 0x7f;
    if (size === 0 || size > 4 || start + size > bytes.length) {
      throw new DerError("bad length");
    }
    length = bytes.readUIntBE(start, size);
    start += size;
  }
  const end = start + length;
  if (end > bytes.length) {
    throw new DerError("truncated");
  }
  return { der: { tag, value: bytes.subarray(start, end) }, next: end };
}

/** The one element that is the whole of `bytes`. */
export function readDer(bytes: Buffer): Der {
  const { der, next } = element(bytes, 0);
  if (next !== bytes.length) {
    throw new DerError("trailing bytes");
  }
  return der;
}

/** The elements inside a constructed element, in order. */
export function childrenOf(parent: Der): readonly Der[] {
  const found: Der[] = [];
  let offset = 0;
  while (offset < parent.value.length) {
    const { der, next } = element(parent.value, offset);
    found.push(der);
    offset = next;
  }
  return found;
}

const SEQUENCE = 0x30;
const OID = 0x06;
const OCTET_STRING = 0x04;
/** `[3]`, constructed: the extensions of a v3 TBSCertificate. */
const EXTENSIONS = 0xa3;

/** The DER body of an OID in dotted form (`1.2.840.113635.100.8.2`). */
export function oidBytes(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const [first = 0, second = 0, ...rest] = parts;
  const out = [40 * first + second];
  for (const part of rest) {
    const chunk = [part & 0x7f];
    for (let left = Math.floor(part / 128); left > 0; left = Math.floor(left / 128)) {
      chunk.unshift((left & 0x7f) | 0x80);
    }
    out.push(...chunk);
  }
  return Buffer.from(out);
}

/** The value (the OCTET STRING's content) of the extension `oid` of the certificate `certificate`, else undefined. */
export function extensionOf(certificate: Buffer, oid: string): Buffer | undefined {
  const wanted = oidBytes(oid);
  for (const extension of extensionsOf(certificate)) {
    const [id, ...rest] = childrenOf(extension);
    if (id?.tag === OID && id.value.equals(wanted)) {
      return rest.find((part) => part.tag === OCTET_STRING)?.value;
    }
  }
  return undefined;
}

/** The extensions of a v3 certificate, in order; none when it has no `[3]`. */
function extensionsOf(certificate: Buffer): readonly Der[] {
  const [tbs] = childrenOf(readDer(certificate));
  if (tbs?.tag !== SEQUENCE) {
    throw new DerError("not a certificate");
  }
  const holder = childrenOf(tbs).find((part) => part.tag === EXTENSIONS);
  const [list] = holder === undefined ? [] : childrenOf(holder);
  return list === undefined ? [] : childrenOf(list);
}
