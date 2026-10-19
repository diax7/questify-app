import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAuthKeys, generateCode, generateToken, hashToken, safeEqual } from "#src/auth/keys";

const SECRET = "s".repeat(32);

describe("tokens", () => {
  it("makes a 256-bit URL-safe token whose hash is its SHA-256", () => {
    const { token, hash } = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateToken().token));
    expect(seen.size).toBe(500);
  });

  it("hashes a known value the standard way", () => {
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("generateCode", () => {
  it("is always six Western digits, including leading zeros", () => {
    const codes = Array.from({ length: 2000 }, () => generateCode());
    expect(codes.every((code) => /^[0-9]{6}$/.test(code))).toBe(true);
    expect(codes.some((code) => code.startsWith("0"))).toBe(true);
  });

  it("uses the whole range", () => {
    const codes = Array.from({ length: 2000 }, () => Number(generateCode()));
    expect(Math.max(...codes)).toBeGreaterThan(900_000);
    expect(Math.min(...codes)).toBeLessThan(100_000);
  });
});

describe("safeEqual", () => {
  it("is true only for equal bytes", () => {
    expect(safeEqual(Buffer.from("abc"), Buffer.from("abc"))).toBe(true);
    expect(safeEqual(Buffer.from("abc"), Buffer.from("abd"))).toBe(false);
  });

  it("treats different lengths as not equal instead of throwing", () => {
    expect(safeEqual(Buffer.from("abc"), Buffer.from("abcd"))).toBe(false);
    expect(safeEqual(Buffer.from(""), Buffer.from("a"))).toBe(false);
  });
});

const hmac = (key: Uint8Array | string, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

const subkey = (purpose: string): Buffer => hmac(SECRET, `questify/auth/v1/${purpose}`);

describe("createAuthKeys", () => {
  const keys = {
    emailKey: (value: string) => createAuthKeys(SECRET).emailKey(value),
    addressKey: (value: string) => createAuthKeys(SECRET).addressKey(value),
    userKey: (value: string) => createAuthKeys(SECRET).userKey(value),
    codeHash: (challengeId: string, code: string) =>
      createAuthKeys(SECRET).codeHash(challengeId, code),
  };

  it("derives each key as HMAC(HMAC(secret, purpose), value), so the format is fixed", () => {
    expect(keys.emailKey("a@x.sa").equals(hmac(subkey("throttle-email"), "a@x.sa"))).toBe(true);
    expect(keys.addressKey("1.2.3.4").equals(hmac(subkey("throttle-address"), "1.2.3.4"))).toBe(
      true,
    );
    expect(keys.userKey("user-1").equals(hmac(subkey("throttle-user"), "user-1"))).toBe(true);
    expect(keys.codeHash("c1", "123456").equals(hmac(subkey("code"), "c1\n123456"))).toBe(true);
  });

  it("refuses a short secret", () => {
    expect(() => createAuthKeys("x".repeat(31))).toThrow(/at least 32/);
    expect(() => createAuthKeys("x".repeat(32))).not.toThrow();
  });

  it("gives 32-byte keys that are stable for the same input", () => {
    expect(keys.emailKey("a@x.sa")).toHaveLength(32);
    expect(keys.emailKey("a@x.sa").equals(keys.emailKey("a@x.sa"))).toBe(true);
    expect(keys.emailKey("a@x.sa").equals(keys.emailKey("b@x.sa"))).toBe(false);
  });

  it("keeps purposes apart: the same text hashes differently for email, address and user", () => {
    const value = "same-text";
    const all = [keys.emailKey(value), keys.addressKey(value), keys.userKey(value)];
    expect(new Set(all.map((key) => key.toString("hex"))).size).toBe(3);
  });

  it("depends on the secret", () => {
    const other = createAuthKeys("t".repeat(32));
    expect(other.emailKey("a@x.sa").equals(keys.emailKey("a@x.sa"))).toBe(false);
    expect(other.codeHash("c", "123456").equals(keys.codeHash("c", "123456"))).toBe(false);
  });

  it("binds a code to its challenge and to its digits", () => {
    const base = keys.codeHash("challenge-1", "123456");
    expect(base).toHaveLength(32);
    expect(keys.codeHash("challenge-1", "123456").equals(base)).toBe(true);
    expect(keys.codeHash("challenge-2", "123456").equals(base)).toBe(false);
    expect(keys.codeHash("challenge-1", "123457").equals(base)).toBe(false);
  });

  it("does not let a challenge id and a code run together to the same hash", () => {
    expect(keys.codeHash("a", "b1").equals(keys.codeHash("a\nb", "1"))).toBe(false);
  });
});
