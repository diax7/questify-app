import { describe, expect, it } from "vitest";
import {
  ARGON2_PARAMS,
  checkPasswordPolicy,
  dummyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "#src/auth/password";

const EMAIL = "sara@najd.sa";
const ACUTE = String.fromCodePoint(0x301);
const E_ACUTE = String.fromCodePoint(0xe9);

describe("checkPasswordPolicy", () => {
  it("refuses 11 characters and accepts 12", () => {
    expect(checkPasswordPolicy("a".repeat(11), EMAIL)).toEqual({ ok: false, reason: "too_short" });
    expect(checkPasswordPolicy("a".repeat(12), EMAIL)).toEqual({ ok: true });
  });

  it("accepts 128 characters and refuses 129", () => {
    expect(checkPasswordPolicy("a".repeat(128), EMAIL)).toEqual({ ok: true });
    expect(checkPasswordPolicy("a".repeat(129), EMAIL)).toEqual({ ok: false, reason: "too_long" });
  });

  it("counts people-visible characters, so 12 emoji are enough and 11 are not", () => {
    expect(checkPasswordPolicy("😀".repeat(12), EMAIL)).toEqual({ ok: true });
    expect(checkPasswordPolicy("😀".repeat(11), EMAIL)).toEqual({ ok: false, reason: "too_short" });
  });

  it("accepts Arabic passwords", () => {
    expect(checkPasswordPolicy("كلمة سر طويلة جدا", EMAIL)).toEqual({ ok: true });
  });

  it("counts after NFKC, so a decomposed string is measured as typed", () => {
    expect(checkPasswordPolicy(`e${ACUTE}`.repeat(11), EMAIL)).toEqual({
      ok: false,
      reason: "too_short",
    });
  });

  it("refuses the account's own email, in any letter case", () => {
    expect(checkPasswordPolicy("Sara@Najd.SA", EMAIL)).toEqual({
      ok: false,
      reason: "same_as_email",
    });
  });

  it("refuses a password that contains the product or company name, in any letter case", () => {
    for (const password of ["my-QUESTIFY-pass", "nafes is the best"]) {
      expect(checkPasswordPolicy(password, EMAIL)).toEqual({ ok: false, reason: "context_word" });
    }
  });

  it("refuses a password that contains the email's name part once it has four characters", () => {
    expect(checkPasswordPolicy("hello SARA 2026!", EMAIL)).toEqual({
      ok: false,
      reason: "context_word",
    });
    expect(checkPasswordPolicy("alibaba and the forty", "ali@najd.sa")).toEqual({ ok: true });
    expect(checkPasswordPolicy("i am omar the great", "omar@najd.sa")).toEqual({
      ok: false,
      reason: "context_word",
    });
  });

  it("asks for no mix of letters, digits or symbols", () => {
    expect(checkPasswordPolicy("aaaaaaaaaaaa", EMAIL)).toEqual({ ok: true });
  });
});

describe("hashPassword and verifyPassword", () => {
  it("round-trips and uses argon2id with the current parameters", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(stored, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(stored, "correct horse battery stapl")).toBe(false);
  });

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same password 123"),
      hashPassword("same password 123"),
    ]);
    expect(a).not.toBe(b);
  });

  it("treats Arabic and emoji passwords as typed, and NFKC-equal forms as the same", async () => {
    const stored = await hashPassword("مرحبا بالعالم 😀 !!");
    expect(await verifyPassword(stored, "مرحبا بالعالم 😀 !!")).toBe(true);
    const composed = await hashPassword(`caf${E_ACUTE} caf${E_ACUTE} caf${E_ACUTE}`);
    expect(await verifyPassword(composed, `cafe${ACUTE} cafe${ACUTE} cafe${ACUTE}`)).toBe(true);
  });

  it("names a damaged stored hash instead of calling it a wrong password", async () => {
    await expect(verifyPassword("not-a-hash", "whatever password")).rejects.toThrow();
  });
});

describe("needsRehash", () => {
  it("is false for a hash made with the current parameters", async () => {
    expect(needsRehash(await hashPassword("some long password"))).toBe(false);
  });

  it.each([
    ["more memory", "$argon2id$v=19$m=65536,t=2,p=1$c2FsdHNhbHQ$aGFzaA"],
    ["more passes", `$argon2id$v=19$m=${ARGON2_PARAMS.memoryCost},t=3,p=1$c2FsdHNhbHQ$aGFzaA`],
    ["more lanes", `$argon2id$v=19$m=${ARGON2_PARAMS.memoryCost},t=2,p=2$c2FsdHNhbHQ$aGFzaA`],
    ["another algorithm", "$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaA"],
    ["no argon2 at all", "plain"],
  ])("is true for %s", (_label, stored) => {
    expect(needsRehash(stored)).toBe(true);
  });
});

describe("dummyVerify", () => {
  it("does a real hash check without throwing, so unknown emails take the same time", async () => {
    await expect(dummyVerify("anything at all")).resolves.toBeUndefined();
  });
});
