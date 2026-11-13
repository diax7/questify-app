import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { AAGUID, NONCE_OID } from "#src/integrity/app-attest";
import { oidBytes } from "#src/integrity/der";

/**
 * Fabricated App Attest objects for offline tests (T-812): a test root, an intermediate and a credential certificate
 * built and signed here (DER written by hand, ECDSA P-256 with SHA-256), CBOR attestations and assertions in Apple's
 * layout. Nothing is recorded from a real phone, so nothing expires or needs a device.
 */

const sha256 = (...parts: readonly Buffer[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

// ---------------------------------------------------------------- DER
function lengthOf(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let left = size; left > 0; left = Math.floor(left / 256)) bytes.unshift(left & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...parts: readonly Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body]);
};
const seq = (...parts: readonly Buffer[]) => tlv(0x30, ...parts);
const oid = (dotted: string) => tlv(0x06, oidBytes(dotted));
const name = (cn: string) => seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));
const utcTime = (at: Date) =>
  tlv(0x17, Buffer.from(`${at.toISOString().slice(2, 19).replace(/[-:T]/g, "")}Z`));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

export type Issued = Readonly<{ cn: string; cert: X509Certificate; der: Buffer; key: KeyObject }>;

export type CertOptions = Readonly<{
  cn: string;
  /** Signs the certificate; none: self-signed with the new key. */
  issuer?: Issued;
  ca?: boolean;
  nonce?: Buffer;
  notAfter?: Date | undefined;
  /** The subject's key; none: a new P-256 key, returned as `key`. */
  publicKey?: KeyObject;
}>;

const TRUE = tlv(0x01, Buffer.from([0xff]));

function extensionsOf(options: CertOptions): Buffer[] {
  const found: Buffer[] = [];
  if (options.ca === true) found.push(seq(oid("2.5.29.19"), TRUE, tlv(0x04, seq(TRUE))));
  if (options.nonce !== undefined) {
    found.push(seq(oid(NONCE_OID), tlv(0x04, seq(tlv(0xa1, tlv(0x04, options.nonce))))));
  }
  return found;
}

/** A certificate for `publicKey` (or a new P-256 key), signed by `issuer` (self-signed without one). */
export function issue(options: CertOptions): Issued {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const subject = options.publicKey ?? pair.publicKey;
  const extensions = extensionsOf(options);
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.concat([Buffer.from([1]), randomBytes(7)])),
    ECDSA_SHA256,
    name(options.issuer?.cn ?? options.cn),
    seq(
      utcTime(new Date(Date.now() - 86_400_000)),
      utcTime(options.notAfter ?? new Date(Date.now() + 86_400_000 * 30)),
    ),
    name(options.cn),
    subject.export({ type: "spki", format: "der" }),
    ...(extensions.length === 0 ? [] : [tlv(0xa3, seq(...extensions))]),
  );
  const signature = sign("sha256", tbs, {
    key: options.issuer?.key ?? pair.privateKey,
    dsaEncoding: "der",
  });
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature));
  return { cn: options.cn, cert: new X509Certificate(der), der, key: pair.privateKey };
}

// ---------------------------------------------------------------- CBOR
export type CborIn = number | Buffer | string | readonly CborIn[] | ReadonlyMap<string, CborIn>;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const out = Buffer.alloc(3);
    out.writeUInt8((major << 5) | 25, 0);
    out.writeUInt16BE(value, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out.writeUInt8((major << 5) | 26, 0);
  out.writeUInt32BE(value, 1);
  return out;
}

export function encodeCbor(value: CborIn): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)]);
  const map = value as ReadonlyMap<string, CborIn>;
  const parts = [...map.entries()].flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)]);
  return Buffer.concat([head(5, map.size), ...parts]);
}

// ---------------------------------------------------------------- App Attest
export const TEST_APP_ID = "ABCDE12345.app.questify.mobile";

/** The P-256 point `04 ‖ x ‖ y` of a key. */
export function pointOf(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(String(jwk.x), "base64url"),
    Buffer.from(String(jwk.y), "base64url"),
  ]);
}

export function authData(
  options: Readonly<{
    appId?: string | undefined;
    counter?: number | undefined;
    aaguid?: Buffer | undefined;
    credential?: Buffer | undefined;
  }>,
): Buffer {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(options.counter ?? 0, 0);
  const fixed = [sha256(Buffer.from(options.appId ?? TEST_APP_ID)), Buffer.from([0x40]), counter];
  if (options.credential === undefined) return Buffer.concat(fixed);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(options.credential.length, 0);
  return Buffer.concat([...fixed, options.aaguid ?? AAGUID.production, length, options.credential]);
}

export type Chain = Readonly<{ root: Issued; middle: Issued }>;

/** A test root and an intermediate CA under it. */
export function testChain(): Chain {
  const root = issue({ cn: "Test App Attestation Root CA", ca: true });
  const middle = issue({ cn: "Test App Attestation CA 1", ca: true, issuer: root });
  return { root, middle };
}

export type AttestOptions = Readonly<{
  chain: Chain;
  clientDataHash: Buffer;
  appId?: string;
  counter?: number;
  aaguid?: Buffer;
  /** Replaces the nonce in the certificate. */
  nonce?: Buffer;
  fmt?: string;
  /** Replaces the credential id in the authenticator data. */
  credential?: Buffer;
  leafNotAfter?: Date;
}>;

export type Attestation = Readonly<{ keyId: Buffer; attestation: Buffer; key: KeyObject }>;

/** An attestation of a new P-256 key, as a phone would make it, with any part replaced to test a refusal. */
export function makeAttestation(options: AttestOptions): Attestation {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyId = sha256(pointOf(pair.publicKey));
  const data = authData({
    appId: options.appId,
    counter: options.counter,
    aaguid: options.aaguid,
    credential: options.credential ?? keyId,
  });
  const leaf = issue({
    cn: "credential",
    issuer: options.chain.middle,
    publicKey: pair.publicKey,
    nonce: options.nonce ?? sha256(data, options.clientDataHash),
    notAfter: options.leafNotAfter,
  });
  const attestation = encodeCbor(
    new Map<string, CborIn>([
      ["fmt", options.fmt ?? "apple-appattest"],
      [
        "attStmt",
        new Map<string, CborIn>([
          ["x5c", [leaf.der, options.chain.middle.der]],
          ["receipt", Buffer.from("receipt")],
        ]),
      ],
      ["authData", data],
    ]),
  );
  return { keyId, attestation, key: pair.privateKey };
}

/** An assertion by `key` over `clientDataHash` with `counter`. */
export function makeAssertion(
  key: KeyObject,
  clientDataHash: Buffer,
  counter: number,
  appId = TEST_APP_ID,
): Buffer {
  const data = authData({ appId, counter });
  const signature = sign("sha256", sha256(data, clientDataHash), { key, dsaEncoding: "der" });
  return encodeCbor(
    new Map<string, CborIn>([
      ["signature", signature],
      ["authenticatorData", data],
    ]),
  );
}
