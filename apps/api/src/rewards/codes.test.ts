import { createCipheriv, createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CODE_MAX_LENGTH,
  createRewardCodeKeyring,
  headerKeyId,
  isCurrent,
  markCode,
  markKeyFor,
  normalizeCode,
  openCode,
  sealCode,
  type RewardCodeKeyring,
} from "#src/rewards/codes";

const R = "r".repeat(32);
const S = "s".repeat(32);
const ring = (id: number, secret: string, previous?: { id: number; secret: string }) =>
  createRewardCodeKeyring({ current: { id, secret }, previous });
/** Today's key: one secret, id 1. */
const KEY = ring(1, R);
/** After a rotation: key 2 current, key 1 kept to open old codes. */
const ROTATED = ring(2, S, { id: 1, secret: R });
/** After the previous secret is removed: key 2 only. */
const ONLY_NEW = ring(2, S);
const REWARD = "0b6f3c1e-8a52-4f0e-9d2a-5c7e1b3a9f10";
const OTHER_REWARD = "7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6";
const ORG_A = "a1b2c3d4-0000-4000-8000-00000000000a";
const ORG_B = "a1b2c3d4-0000-4000-8000-00000000000b";
/** "FIXTURE-1" sealed for REWARD under key 1 (secret R) in the `0x51 0x02 keyId` format, IV "fixture-iv-1". */
const SEALED_FIXTURE =
  "510201666978747572652d69762d3184a753f737d2159dcdbb604e09638d399cafb60ff634980de4";

/** A value sealed exactly as before T-810f: `iv ‖ tag ‖ ciphertext` under the secret's key, AAD = reward id. */
function legacySeal(secret: string, rewardId: string, code: string, iv: Buffer): Buffer {
  const key = Buffer.from(
    hkdfSync("sha256", secret, "questify/reward-code", "questify/reward-code/v1/seal", 32),
  );
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(rewardId));
  const body = Buffer.concat([cipher.update(code), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

const codeOf = (keys: RewardCodeKeyring, rewardId: string, sealed: Buffer) =>
  openCode(keys, rewardId, sealed)?.code;

describe("reward code keyring", () => {
  it("derives two different keys from one secret, and other keys from another", () => {
    expect(KEY.current.seal.equals(KEY.current.mark)).toBe(false);
    expect(KEY.current.seal).toHaveLength(32);
    expect(ROTATED.current.seal.equals(KEY.current.seal)).toBe(false);
    expect(ROTATED.previous?.seal.equals(KEY.current.seal)).toBe(true);
    expect([...ROTATED.keys.keys()]).toEqual([2, 1]);
    expect(KEY.previous).toBeUndefined();
    expect([...KEY.keys.keys()]).toEqual([1]);
  });
});

describe("sealing a code", () => {
  it("opens to the same code for the same reward, with the key id in the header", () => {
    const sealed = sealCode(ROTATED, REWARD, "SAVE-20-كود");
    expect([...sealed.subarray(0, 3)]).toEqual([0x51, 0x02, 2]);
    expect(headerKeyId(sealed)).toBe(2);
    expect(openCode(ROTATED, REWARD, sealed)).toEqual({
      code: "SAVE-20-كود",
      keyId: 2,
      legacy: false,
    });
    expect(codeOf(ONLY_NEW, REWARD, sealed)).toBe("SAVE-20-كود");
  });

  it("never seals one code twice the same way", () => {
    expect(sealCode(KEY, REWARD, "A").equals(sealCode(KEY, REWARD, "A"))).toBe(false);
  });

  it("does not open for another reward, a ring without its key, or a changed byte", () => {
    const sealed = sealCode(KEY, REWARD, "GIFT-1");
    expect(codeOf(KEY, OTHER_REWARD, sealed)).toBeUndefined();
    expect(codeOf(ONLY_NEW, REWARD, sealed)).toBeUndefined();
    expect(codeOf(ring(1, S), REWARD, sealed)).toBeUndefined();
    for (const at of [0, 1, 2, 3, 15, 31, sealed.length - 1]) {
      const changed = Buffer.from(sealed);
      changed[at] = (changed[at] ?? 0) ^ 0x01;
      expect(codeOf(KEY, REWARD, changed), `byte ${at}`).toBeUndefined();
    }
    expect(codeOf(KEY, REWARD, sealed.subarray(0, 31))).toBeUndefined();
    expect(codeOf(KEY, REWARD, sealed.subarray(0, 3))).toBeUndefined();
    expect(codeOf(KEY, REWARD, Buffer.alloc(0))).toBeUndefined();
  });

  it("binds the header: the same body under another key id is refused", () => {
    const sealed = sealCode(ROTATED, REWARD, "GIFT-2");
    const swapped = Buffer.from(sealed);
    swapped[2] = 1;
    expect(codeOf(ROTATED, REWARD, swapped)).toBeUndefined();
    const sameKeyTwice = ring(2, S, { id: 1, secret: S });
    expect(codeOf(sameKeyTwice, REWARD, sealed)).toBe("GIFT-2");
    expect(codeOf(sameKeyTwice, REWARD, swapped)).toBeUndefined();
    expect(codeOf(sameKeyTwice, REWARD, sealed.subarray(3))).toBeUndefined();
  });

  it("refuses a header that names a key the ring lacks, unless the value opens as a legacy seal", () => {
    const sealed = sealCode(ring(9, S), REWARD, "GIFT-3");
    expect(codeOf(ROTATED, REWARD, sealed)).toBeUndefined();
    expect(codeOf(ring(9, S), REWARD, sealed)).toBe("GIFT-3");
  });

  it("reads a key id only from a value longer than the header that starts with both magic bytes", () => {
    expect(headerKeyId(Buffer.from([0x51, 0x02, 5, 0]))).toBe(5);
    expect(headerKeyId(Buffer.from([0x51, 0x02, 5]))).toBeUndefined();
    expect(headerKeyId(Buffer.from([0x00, 0x02, 5, 0]))).toBeUndefined();
    expect(headerKeyId(Buffer.from([0x51, 0x00, 5, 0]))).toBeUndefined();
    expect(headerKeyId(Buffer.from([0x00, 0x00, 5, 0]))).toBeUndefined();
  });

  // Mutation run 42106959753, equivalent survivors in openCode/openBody: emptying openBody's `catch` still returns
  // undefined; and dropping the `named === undefined`, `key !== undefined` or `legacy === undefined` guards only
  // reaches `ring.keys.get(undefined)` or `openBody(undefined, ...)`, whose `key.seal` throws inside the same try.

  it("fits the database's size check for the longest code and the shortest", () => {
    const longest = sealCode(KEY, REWARD, "ك".repeat(CODE_MAX_LENGTH));
    expect(longest.length).toBeLessThanOrEqual(1024);
    expect(sealCode(KEY, REWARD, "A").length).toBe(32);
  });
});

describe("legacy codes (sealed before T-810f)", () => {
  const iv = Buffer.from("0123456789ab");

  it("open under key 1 only, reported as legacy", () => {
    const sealed = legacySeal(R, REWARD, "OLD-1", iv);
    expect(openCode(KEY, REWARD, sealed)).toEqual({ code: "OLD-1", keyId: 1, legacy: true });
    expect(openCode(ROTATED, REWARD, sealed)).toEqual({ code: "OLD-1", keyId: 1, legacy: true });
    expect(codeOf(ONLY_NEW, REWARD, sealed)).toBeUndefined();
    expect(codeOf(ring(2, R), REWARD, sealed)).toBeUndefined();
    expect(codeOf(KEY, OTHER_REWARD, sealed)).toBeUndefined();
  });

  it("open even when the IV starts like a header naming a key the ring holds", () => {
    for (const third of [1, 2]) {
      const lookalike = Buffer.concat([Buffer.from([0x51, 0x02, third]), iv.subarray(3)]);
      const sealed = legacySeal(R, REWARD, "OLD-2", lookalike);
      expect(headerKeyId(sealed)).toBe(third);
      expect(openCode(ROTATED, REWARD, sealed), `key ${third}`).toEqual({
        code: "OLD-2",
        keyId: 1,
        legacy: true,
      });
    }
  });

  it("count as current only once re-sealed under the current key", () => {
    const legacy = openCode(KEY, REWARD, legacySeal(R, REWARD, "OLD-3", iv));
    const previous = openCode(ROTATED, REWARD, sealCode(KEY, REWARD, "OLD-3"));
    const fresh = openCode(ROTATED, REWARD, sealCode(ROTATED, REWARD, "OLD-3"));
    expect(legacy && isCurrent(KEY, legacy)).toBe(false);
    expect(previous && isCurrent(ROTATED, previous)).toBe(false);
    expect(fresh && isCurrent(ROTATED, fresh)).toBe(true);
    expect(fresh && isCurrent(ring(3, "t".repeat(32)), fresh)).toBe(false);
  });
});

describe("normalizing and marking a code", () => {
  it("trims, applies NFC and refuses empty, long or control-character codes", () => {
    expect(normalizeCode("  AB-12 \n")).toBe("AB-12");
    expect(normalizeCode("é")).toBe("é");
    expect(normalizeCode("   ")).toBeUndefined();
    expect(normalizeCode("A".repeat(CODE_MAX_LENGTH))).toHaveLength(CODE_MAX_LENGTH);
    expect(normalizeCode("A".repeat(CODE_MAX_LENGTH + 1))).toBeUndefined();
    expect(normalizeCode("A\u0000B")).toBeUndefined();
    expect(normalizeCode("A\tB")).toBeUndefined();
  });

  it("marks a code the same way every time, two codes differently, and differently under each key", () => {
    const key = markKeyFor(KEY.current, ORG_A);
    expect(markCode(key, "A").equals(markCode(key, "A"))).toBe(true);
    expect(markCode(key, "A").equals(markCode(key, "B"))).toBe(false);
    expect(markCode(key, "A").equals(markCode(markKeyFor(ROTATED.current, ORG_A), "A"))).toBe(
      false,
    );
    const previous = ROTATED.previous;
    expect(previous && markCode(markKeyFor(previous, ORG_A), "A").equals(markCode(key, "A"))).toBe(
      true,
    );
    expect(markCode(key, "A")).toHaveLength(32);
  });
});

/** An organizer's mark key under today's key, derived the documented way. */
const v2 = (organizerId: string) =>
  Buffer.from(
    hkdfSync("sha256", KEY.current.mark, "", `questify/reward-code/v2/mark/${organizerId}`, 32),
  );

describe("the per-organizer mark (w2-crypto 3)", () => {
  it("gives two organizers two marks for one code, and one organizer the same mark every time", () => {
    const a = markCode(markKeyFor(KEY.current, ORG_A), "VOUCHER-1");
    const b = markCode(markKeyFor(KEY.current, ORG_B), "VOUCHER-1");
    expect(a.equals(b)).toBe(false);
    expect(markCode(markKeyFor(KEY.current, ORG_A), "VOUCHER-1").equals(a)).toBe(true);
  });

  it("derives the organizer's key by HKDF from the mark key with a v2 label (a fixed format)", () => {
    expect(markKeyFor(KEY.current, ORG_A).equals(v2(ORG_A))).toBe(true);
    expect(markKeyFor(KEY.current, ORG_A)).toHaveLength(32);
    const expected = createHmac("sha256", v2(ORG_A)).update("VOUCHER-1").digest();
    expect(markCode(markKeyFor(KEY.current, ORG_A), "VOUCHER-1").equals(expected)).toBe(true);
  });

  it("is not the old mark every organizer shared (v1)", () => {
    const v1 = createHmac("sha256", KEY.current.mark).update("VOUCHER-1").digest();
    expect(markCode(markKeyFor(KEY.current, ORG_A), "VOUCHER-1").equals(v1)).toBe(false);
  });

  it.each([ORG_A.toUpperCase(), "not-a-uuid", "", `${ORG_A} `, `${ORG_A}0`])(
    "refuses the organizer id %j",
    (organizerId) => {
      expect(() => markKeyFor(KEY.current, organizerId)).toThrow(/organizer/);
    },
  );

  it("leaves the seal alone: a code sealed before the change still opens", () => {
    const sealed = Buffer.from(SEALED_FIXTURE, "hex");
    expect(openCode(KEY, REWARD, sealed)).toEqual({ code: "FIXTURE-1", keyId: 1, legacy: false });
  });
});
