import { createHash, createPublicKey, verify, X509Certificate, type KeyObject } from "node:crypto";
import { safeEqual } from "#src/auth/keys";
import { asBytes, asMap, decodeCbor, type Cbor, type CborMap } from "#src/integrity/cbor";
import { extensionOf, childrenOf, readDer } from "#src/integrity/der";

/**
 * Apple App Attest on the server (T-812, ADR-833), by Apple's "Validating apps that connect to your server": the
 * attestation once per key, then an assertion per check. Pure functions over bytes; the caller stores the key and its
 * counter.
 */

/** Apple App Attestation Root CA (https://www.apple.com/certificateauthority/), valid until 2045-03-15. */
export const APPLE_APP_ATTEST_ROOT = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

/** The credential certificate's extension that holds the attestation's nonce. */
export const NONCE_OID = "1.2.840.113635.100.8.2";
/** The `aaguid` of a production key and of a development one (16 bytes each). */
export const AAGUID = {
  production: Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]),
  development: Buffer.from("appattestdevelop"),
} as const;

export type AppAttestSettings = Readonly<{
  /** `TEAMID.bundle.id`, whose SHA-256 is the `rpIdHash`. */
  appId: string;
  /** Accept development keys (a development build) besides production ones. */
  development: boolean;
  /** The trusted root; Apple's unless a test gives its own. */
  root: X509Certificate;
}>;

/** Why an attestation or an assertion was refused; stored as the device check's reasons. */
export type AttestReason =
  | "format"
  | "chain"
  | "nonce"
  | "key_id"
  | "rp_id"
  | "counter"
  | "aaguid"
  | "credential"
  | "signature";

export type Attested = Readonly<{ ok: true; publicKey: Buffer; development: boolean }>;
export type Refused = Readonly<{ ok: false; reason: AttestReason }>;

const sha256 = (...parts: readonly Buffer[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const refused = (reason: AttestReason): Refused => ({ ok: false, reason });

/** The authenticator data's fixed fields (WebAuthn layout); undefined when it is too short. */
type AuthData = Readonly<{ rpIdHash: Buffer; counter: number; rest: Buffer }>;
function authDataOf(bytes: Buffer): AuthData | undefined {
  if (bytes.length < 37) {
    return undefined;
  }
  return {
    rpIdHash: bytes.subarray(0, 32),
    counter: bytes.readUInt32BE(33),
    rest: bytes.subarray(37),
  };
}

/** The certificate in `der`, else undefined. */
function certificate(der: Cbor | undefined): X509Certificate | undefined {
  const bytes = asBytes(der);
  try {
    return bytes === undefined ? undefined : new X509Certificate(bytes);
  } catch {
    return undefined;
  }
}

const within = (cert: X509Certificate, now: Date): boolean =>
  cert.validFromDate <= now && now <= cert.validToDate;

/** Step 1: credential certificate ← intermediate ← the root, each signed by the next and valid now. */
function chainHolds(
  leaf: X509Certificate,
  middle: X509Certificate,
  root: X509Certificate,
  now: Date,
): boolean {
  return (
    middle.ca &&
    middle.checkIssued(root) &&
    middle.verify(root.publicKey) &&
    leaf.checkIssued(middle) &&
    leaf.verify(middle.publicKey) &&
    within(leaf, now) &&
    within(middle, now) &&
    within(root, now)
  );
}

/** The nonce in the credential certificate's extension: `SEQUENCE { [1] { OCTET STRING nonce } }`. */
function certificateNonce(leaf: X509Certificate): Buffer | undefined {
  try {
    const value = extensionOf(leaf.raw, NONCE_OID);
    if (value === undefined) return undefined;
    const [tagged] = childrenOf(readDer(value));
    const [octets] = tagged?.tag === 0xa1 ? childrenOf(tagged) : [];
    return octets?.tag === 0x04 ? octets.value : undefined;
  } catch {
    return undefined;
  }
}

/** The uncompressed EC point (`04 ‖ x ‖ y`) of a P-256 key, whose SHA-256 is the App Attest key id. */
function pointOf(key: KeyObject): Buffer | undefined {
  const jwk = key.export({ format: "jwk" });
  if (jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    return undefined;
  }
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
}

/** The map at the top of a CBOR object, else undefined (malformed CBOR included). */
function decodeMap(bytes: Buffer): CborMap | undefined {
  try {
    return asMap(decodeCbor(bytes));
  } catch {
    return undefined;
  }
}

const rpIdHolds = (auth: AuthData, appId: string): boolean =>
  safeEqual(auth.rpIdHash, sha256(Buffer.from(appId)));

/** The key's environment by its `aaguid`, or undefined for one not taken here. */
function environmentOf(
  auth: AuthData,
  settings: AppAttestSettings,
): "production" | "development" | undefined {
  const aaguid = auth.rest.subarray(0, 16);
  if (aaguid.equals(AAGUID.production)) return "production";
  return settings.development && aaguid.equals(AAGUID.development) ? "development" : undefined;
}

/** Whether the credential id after the `aaguid` is the 32-byte key id. */
function credentialHolds(auth: AuthData, keyId: Buffer): boolean {
  if (auth.rest.length < 18) return false;
  const length = auth.rest.readUInt16BE(16);
  return length === 32 && auth.rest.subarray(18, 18 + length).equals(keyId);
}

type Parts = Readonly<{
  leaf: X509Certificate;
  middle: X509Certificate;
  authData: Buffer;
  auth: AuthData;
}>;

const chainOf = (top: CborMap | undefined): readonly Cbor[] | undefined => {
  const chain = asMap(top?.get("attStmt"))?.get("x5c");
  return Array.isArray(chain) ? chain : undefined;
};

/** The attestation's parts, or undefined when it is not `apple-appattest` CBOR with two certificates. */
function partsOf(attestation: Buffer): Parts | undefined {
  const top = decodeMap(attestation);
  const chain = top?.get("fmt") === "apple-appattest" ? chainOf(top) : undefined;
  const authData = asBytes(top?.get("authData"));
  return chain === undefined || authData === undefined ? undefined : partsFrom(chain, authData);
}

function partsFrom(chain: readonly Cbor[], authData: Buffer): Parts | undefined {
  const leaf = certificate(chain[0]);
  const middle = certificate(chain[1]);
  const auth = authDataOf(authData);
  return leaf && middle && auth ? { leaf, middle, authData, auth } : undefined;
}

function nonceHolds(parts: Parts, clientDataHash: Buffer): boolean {
  const nonce = certificateNonce(parts.leaf);
  return nonce !== undefined && safeEqual(nonce, sha256(parts.authData, clientDataHash));
}

function keyIdHolds(leaf: X509Certificate, keyId: Buffer): boolean {
  const point = pointOf(leaf.publicKey);
  return point !== undefined && safeEqual(sha256(point), keyId);
}

type AttestInput = Readonly<{ keyId: Buffer; attestation: Buffer; clientDataHash: Buffer }>;

/** Apple's steps in order; the first that fails names the refusal. */
function attestationRefusal(
  parts: Parts,
  input: AttestInput,
  settings: AppAttestSettings,
  now: Date,
): AttestReason | undefined {
  const steps: ReadonlyArray<readonly [AttestReason, () => boolean]> = [
    ["chain", () => chainHolds(parts.leaf, parts.middle, settings.root, now)],
    ["nonce", () => nonceHolds(parts, input.clientDataHash)],
    ["key_id", () => keyIdHolds(parts.leaf, input.keyId)],
    ["rp_id", () => rpIdHolds(parts.auth, settings.appId)],
    ["counter", () => parts.auth.counter === 0],
    ["aaguid", () => environmentOf(parts.auth, settings) !== undefined],
    ["credential", () => credentialHolds(parts.auth, input.keyId)],
  ];
  return steps.find(([, holds]) => !holds())?.[0];
}

/**
 * Verifies a key's attestation (Apple's nine steps; the receipt is not read). `keyId` is the key's id as the app
 * gives it (32 bytes), `clientDataHash` the SHA-256 of the challenge.
 */
export function verifyAttestation(
  input: AttestInput,
  settings: AppAttestSettings,
  now: Date,
): Attested | Refused {
  const parts = partsOf(input.attestation);
  if (parts === undefined) return refused("format");
  const refusal = attestationRefusal(parts, input, settings, now);
  if (refusal !== undefined) return refused(refusal);
  return {
    ok: true,
    publicKey: parts.leaf.publicKey.export({ format: "der", type: "spki" }),
    development: environmentOf(parts.auth, settings) === "development",
  };
}

export type Asserted = Readonly<{ ok: true; counter: number; repeat: boolean }>;

/** The assertion's signature and authenticator data, else undefined. */
function assertionParts(
  bytes: Buffer,
): Readonly<{ signature: Buffer; data: Buffer; auth: AuthData }> | undefined {
  const top = decodeMap(bytes);
  const signature = asBytes(top?.get("signature"));
  const data = asBytes(top?.get("authenticatorData"));
  const auth = data === undefined ? undefined : authDataOf(data);
  return signature && data && auth ? { signature, data, auth } : undefined;
}

/** Whether `signature` (ECDSA, DER) by the SPKI key `publicKey` holds over the SHA-256 of `message`. */
function signedBy(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  try {
    const key = createPublicKey({ key: publicKey, format: "der", type: "spki" });
    return verify("sha256", message, { key, dsaEncoding: "der" }, signature);
  } catch {
    return false;
  }
}

/**
 * Verifies an assertion with the stored key (Apple's six steps): the signature over SHA-256(authenticatorData ‖
 * clientDataHash), the rpId, and a counter not below `storedCounter`. A counter equal to it is a resend of the last accepted
 * assertion (an honest retry after a timeout): it holds with `repeat` set and the caller records nothing. The caller
 * holds the key's row locked and stores a higher counter.
 */
export function verifyAssertion(
  input: Readonly<{
    assertion: Buffer;
    clientDataHash: Buffer;
    publicKey: Buffer;
    storedCounter: number;
  }>,
  settings: Pick<AppAttestSettings, "appId">,
): Asserted | Refused {
  const parts = assertionParts(input.assertion);
  if (parts === undefined) return refused("format");
  const nonce = sha256(parts.data, input.clientDataHash);
  if (!signedBy(input.publicKey, nonce, parts.signature)) return refused("signature");
  if (!rpIdHolds(parts.auth, settings.appId)) return refused("rp_id");
  if (parts.auth.counter < input.storedCounter) return refused("counter");
  return {
    ok: true,
    counter: parts.auth.counter,
    repeat: parts.auth.counter === input.storedCounter,
  };
}

/** The SHA-256 the app signs over as the client data: the challenge's text. */
export const clientDataHashOf = (challenge: string): Buffer =>
  sha256(Buffer.from(challenge, "utf8"));
