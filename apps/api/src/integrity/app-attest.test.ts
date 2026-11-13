import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AAGUID,
  APPLE_APP_ATTEST_ROOT,
  clientDataHashOf,
  verifyAssertion,
  verifyAttestation,
  type AppAttestSettings,
} from "#src/integrity/app-attest";
import {
  TEST_APP_ID,
  encodeCbor,
  issue,
  makeAssertion,
  makeAttestation,
  testChain,
  type AttestOptions,
} from "#test/support/app-attest";

const chain = testChain();
const settings: AppAttestSettings = {
  appId: TEST_APP_ID,
  development: false,
  root: chain.root.cert,
};
const clientDataHash = clientDataHashOf("a-challenge");
const now = new Date();

const attest = (options: Partial<AttestOptions> = {}, using = settings) => {
  const made = makeAttestation({ chain, clientDataHash, ...options });
  return {
    made,
    result: verifyAttestation(
      { keyId: made.keyId, attestation: made.attestation, clientDataHash },
      using,
      now,
    ),
  };
};

describe("App Attest attestation (T-812)", () => {
  it("takes a production key chained to the root, and answers its public key", () => {
    const { result } = attest();
    expect(result).toMatchObject({ ok: true, development: false });
    expect(result.ok && result.publicKey.length).toBe(91);
  });

  it("checks the real Apple root itself", () => {
    const apple = new X509Certificate(APPLE_APP_ATTEST_ROOT);
    expect(apple.subject).toContain("Apple App Attestation Root CA");
    expect(apple.verify(apple.publicKey)).toBe(true);
    expect(apple.ca).toBe(true);
  });

  it("refuses a chain to another root", () => {
    const other = testChain();
    expect(attest({ chain: other }).result).toEqual({ ok: false, reason: "chain" });
  });

  it("refuses an expired credential certificate", () => {
    expect(attest({ leafNotAfter: new Date(Date.now() - 1000) }).result).toEqual({
      ok: false,
      reason: "chain",
    });
  });

  it("refuses an intermediate that is not a CA", () => {
    const middle = issue({ cn: "Not a CA", issuer: chain.root });
    expect(attest({ chain: { root: chain.root, middle } }).result).toEqual({
      ok: false,
      reason: "chain",
    });
  });

  it("refuses a nonce that is not SHA-256(authData ‖ clientDataHash)", () => {
    expect(attest({ nonce: Buffer.alloc(32, 7) }).result).toEqual({ ok: false, reason: "nonce" });
    const made = makeAttestation({ chain, clientDataHash });
    const other = clientDataHashOf("another-challenge");
    expect(
      verifyAttestation(
        { keyId: made.keyId, attestation: made.attestation, clientDataHash: other },
        settings,
        now,
      ),
    ).toEqual({ ok: false, reason: "nonce" });
  });

  it("refuses a key id that is not the certificate key's", () => {
    const made = makeAttestation({ chain, clientDataHash });
    expect(
      verifyAttestation(
        { keyId: Buffer.alloc(32, 1), attestation: made.attestation, clientDataHash },
        settings,
        now,
      ),
    ).toEqual({ ok: false, reason: "key_id" });
  });

  it("refuses another app, a used counter, a credential id that differs", () => {
    expect(attest({ appId: "ABCDE12345.app.other" }).result).toEqual({
      ok: false,
      reason: "rp_id",
    });
    expect(attest({ counter: 1 }).result).toEqual({ ok: false, reason: "counter" });
    expect(attest({ credential: Buffer.alloc(32, 9) }).result).toEqual({
      ok: false,
      reason: "credential",
    });
    expect(attest({ credential: Buffer.alloc(16, 9) }).result).toEqual({
      ok: false,
      reason: "credential",
    });
  });

  it("takes a development key only when development keys are on", () => {
    expect(attest({ aaguid: AAGUID.development }).result).toEqual({ ok: false, reason: "aaguid" });
    expect(attest({ aaguid: Buffer.alloc(16) }).result).toEqual({ ok: false, reason: "aaguid" });
    const dev = attest({ aaguid: AAGUID.development }, { ...settings, development: true }).result;
    expect(dev).toMatchObject({ ok: true, development: true });
  });

  it("refuses what is not an apple-appattest object", () => {
    expect(attest({ fmt: "packed" }).result).toEqual({ ok: false, reason: "format" });
    for (const junk of [
      Buffer.from("nope"),
      encodeCbor([1, 2]),
      encodeCbor(new Map([["fmt", "apple-appattest"]])),
    ]) {
      expect(
        verifyAttestation(
          { keyId: Buffer.alloc(32), attestation: junk, clientDataHash },
          settings,
          now,
        ),
      ).toEqual({
        ok: false,
        reason: "format",
      });
    }
  });
});

describe("App Attest assertion (T-812)", () => {
  const { made, result } = attest();
  const publicKey = result.ok ? result.publicKey : Buffer.alloc(0);
  const check = (assertion: Buffer, storedCounter = 0, hash = clientDataHash) =>
    verifyAssertion({ assertion, clientDataHash: hash, publicKey, storedCounter }, settings);

  it("takes a signature by the attested key with a higher counter, and answers the counter", () => {
    expect(check(makeAssertion(made.key, clientDataHash, 1))).toEqual({ ok: true, counter: 1 });
    expect(check(makeAssertion(made.key, clientDataHash, 8), 7)).toEqual({ ok: true, counter: 8 });
  });

  it("refuses a counter that does not move forward (a replay)", () => {
    expect(check(makeAssertion(made.key, clientDataHash, 7), 7)).toEqual({
      ok: false,
      reason: "counter",
    });
    expect(check(makeAssertion(made.key, clientDataHash, 3), 7)).toEqual({
      ok: false,
      reason: "counter",
    });
  });

  it("refuses another key, another challenge, another app", () => {
    const stranger = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    expect(check(makeAssertion(stranger, clientDataHash, 1))).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(check(makeAssertion(made.key, clientDataHash, 1), 0, clientDataHashOf("other"))).toEqual(
      {
        ok: false,
        reason: "signature",
      },
    );
    expect(check(makeAssertion(made.key, clientDataHash, 1, "ABCDE12345.app.other"))).toEqual({
      ok: false,
      reason: "rp_id",
    });
  });

  it("refuses a malformed assertion", () => {
    expect(check(Buffer.from([0xff]))).toEqual({ ok: false, reason: "format" });
    expect(check(encodeCbor(new Map([["signature", Buffer.alloc(8)]])))).toEqual({
      ok: false,
      reason: "format",
    });
    const short = encodeCbor(
      new Map<string, Buffer>([
        ["signature", Buffer.alloc(8)],
        ["authenticatorData", Buffer.alloc(10)],
      ]),
    );
    expect(check(short)).toEqual({ ok: false, reason: "format" });
    const garbled = encodeCbor(
      new Map<string, Buffer>([
        ["signature", Buffer.from("not der")],
        ["authenticatorData", Buffer.alloc(37)],
      ]),
    );
    expect(check(garbled)).toEqual({ ok: false, reason: "signature" });
  });
});
