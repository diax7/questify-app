import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { CborError, decodeCbor } from "#src/integrity/cbor";
import { CHALLENGE_SECONDS, challengeHolds, makeChallenge } from "#src/integrity/challenge";
import { DerError, childrenOf, extensionOf, oidBytes, readDer } from "#src/integrity/der";
import { encodeCbor, issue } from "#test/support/app-attest";

describe("the CBOR reader (T-812)", () => {
  it("reads the kinds App Attest uses", () => {
    const value = decodeCbor(
      encodeCbor(
        new Map<string, never>([["a", [1, -2, 300, 70_000, "x", Buffer.from([1, 2])] as never]]),
      ),
    );
    expect(value).toEqual(new Map([["a", [1, -2, 300, 70_000, "x", Buffer.from([1, 2])]]]));
    expect(decodeCbor(Buffer.from([0xf4]))).toBe(false);
    expect(decodeCbor(Buffer.from([0xf5]))).toBe(true);
    expect(decodeCbor(Buffer.from([0xf6]))).toBeNull();
    expect(decodeCbor(Buffer.from([0xa1, 0x01, 0x02]))).toEqual(new Map([[1, 2]]));
  });

  it("refuses what Apple never sends", () => {
    for (const bytes of [
      [],
      [0x18],
      [0x42, 0x01],
      [0x01, 0x02],
      [0xc0, 0x01],
      [0xf9, 0x00, 0x00],
      [0x5f],
      [0x1b, 0, 0, 0, 0, 0, 0, 0, 1],
      [0xa1, 0x40, 0x01],
      [0xa2, 0x01, 0x01, 0x01, 0x02],
      [0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x01],
    ]) {
      expect(() => decodeCbor(Buffer.from(bytes)), JSON.stringify(bytes)).toThrow(CborError);
    }
  });
});

describe("the DER reader (T-812)", () => {
  it("encodes OIDs as DER does", () => {
    expect(oidBytes("1.2.840.113635.100.8.2").toString("hex")).toBe("2a864886f763640802");
    expect(oidBytes("2.5.29.19").toString("hex")).toBe("551d13");
  });

  it("finds an extension of a certificate, and none when absent", () => {
    const cert = issue({ cn: "x", nonce: Buffer.alloc(32, 5) });
    const value = extensionOf(cert.der, "1.2.840.113635.100.8.2");
    expect(value).toBeDefined();
    const [tagged] = childrenOf(readDer(value ?? Buffer.alloc(0)));
    expect(tagged?.tag).toBe(0xa1);
    expect(extensionOf(cert.der, "2.5.29.19")).toBeUndefined();
    expect(extensionOf(issue({ cn: "plain" }).der, "2.5.29.19")).toBeUndefined();
  });

  it("refuses malformed DER", () => {
    for (const bytes of [
      [0x30],
      [0x30, 0x05, 0x00],
      [0x1f, 0x01, 0x00],
      [0x30, 0x85, 1, 1, 1, 1, 1],
      [0x30, 0x00, 0x00],
    ]) {
      expect(() => readDer(Buffer.from(bytes)), JSON.stringify(bytes)).toThrow(DerError);
    }
    expect(() => extensionOf(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]), "1.2")).toThrow(DerError);
  });
});

describe("the challenge (T-812)", () => {
  const key = createAuthKeys("s".repeat(40)).integrityChallengeTag;
  const holder = { playerId: randomUUID(), installId: randomUUID() };
  const now = 1_800_000_000;

  it("holds for its player and install until it expires", () => {
    const { challenge, expiresAt } = makeChallenge(key, holder, now);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{50}$/);
    expect(expiresAt).toBe(now + CHALLENGE_SECONDS);
    expect(challengeHolds(key, holder, challenge, now)).toBe(true);
    expect(challengeHolds(key, holder, challenge, expiresAt - 1)).toBe(true);
    expect(challengeHolds(key, holder, challenge, expiresAt)).toBe(false);
    expect(challengeHolds(key, { ...holder, installId: randomUUID() }, challenge, now)).toBe(false);
    expect(challengeHolds(key, { ...holder, playerId: randomUUID() }, challenge, now)).toBe(false);
    expect(
      challengeHolds(createAuthKeys("o".repeat(40)).integrityChallengeTag, holder, challenge, now),
    ).toBe(false);
  });

  it("refuses a changed, short or foreign challenge", () => {
    const { challenge } = makeChallenge(key, holder, now);
    const bytes = Buffer.from(challenge, "base64url");
    const later = Buffer.from(bytes);
    later.writeUInt32BE(now + 999_999, 1);
    expect(challengeHolds(key, holder, later.toString("base64url"), now)).toBe(false);
    const version = Buffer.from(bytes);
    version.writeUInt8(2, 0);
    expect(challengeHolds(key, holder, version.toString("base64url"), now)).toBe(false);
    for (const bad of ["", "x".repeat(50), `${challenge}=`, challenge.slice(1), "!".repeat(50)]) {
      expect(challengeHolds(key, holder, bad, now), bad).toBe(false);
    }
  });
});
