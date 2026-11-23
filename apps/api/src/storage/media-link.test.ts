import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { checkLink, linkKeyOf, signLink } from "#src/storage/media-link";

vi.mock("node:crypto", async (original) => {
  const real = await original<typeof crypto>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

const KEY =
  "o/11111111-1111-4111-8111-111111111111/e/22222222-2222-4222-8222-222222222222/submission/33333333-3333-4333-8333-333333333333.jpg";
const OTHER = KEY.replace(
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
);
const NOW = 1_800_000_000_000;
const SECRET = "a-media-url-secret-of-32-characters!!";

/** A value that is not a string but reads as one. */
const reads = (text: string) => ({ toString: () => text, [Symbol.toPrimitive]: () => text });

/** The media route's links (ADR-840): an HMAC over the key and expiry, checked in constant time, at most 305 s away. */
describe("media links", () => {
  const linkKey = linkKeyOf(SECRET);
  const expiry = NOW / 1000 + 300;
  const s = signLink(linkKey, KEY, expiry);

  it("round-trips, and is 16 bytes in base64url", () => {
    expect(s).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(checkLink(linkKey, KEY, String(expiry), s, NOW)).toBe(true);
    expect(signLink(linkKey, KEY, expiry)).toBe(s);
  });

  it("fails for another key, expiry, signature byte or secret", () => {
    expect(checkLink(linkKey, OTHER, String(expiry), s, NOW)).toBe(false);
    expect(checkLink(linkKey, KEY, String(expiry - 1), s, NOW)).toBe(false);
    const flipped = Buffer.from(s, "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(checkLink(linkKey, KEY, String(expiry), flipped.toString("base64url"), NOW)).toBe(false);
    expect(checkLink(linkKeyOf(`${SECRET}x`), KEY, String(expiry), s, NOW)).toBe(false);
  });

  it("fails once expired, and for an expiry more than 305 s away even when signed", () => {
    expect(checkLink(linkKey, KEY, String(expiry), s, (expiry + 0) * 1000)).toBe(false);
    expect(checkLink(linkKey, KEY, String(expiry), s, (expiry - 1) * 1000)).toBe(true);
    const far = NOW / 1000 + 306;
    expect(checkLink(linkKey, KEY, String(far), signLink(linkKey, KEY, far), NOW)).toBe(false);
    const edge = NOW / 1000 + 305;
    expect(checkLink(linkKey, KEY, String(edge), signLink(linkKey, KEY, edge), NOW)).toBe(true);
  });

  it("refuses malformed values before the compare, and compares equal lengths in constant time", () => {
    const compare = vi.mocked(crypto.timingSafeEqual);
    compare.mockClear();
    for (const [e, sig] of [
      [undefined, s],
      [String(expiry), undefined],
      [[String(expiry)], s],
      ["0x10", s],
      [String(expiry), s.slice(1)],
      [String(expiry), `${s}A`],
      [String(expiry), s.replace(/.$/, "=")],
    ] as const) {
      expect(checkLink(linkKey, KEY, e, sig, NOW)).toBe(false);
    }
    expect(compare).not.toHaveBeenCalled();
    expect(checkLink(linkKey, KEY, String(expiry), s, NOW)).toBe(true);
    expect(compare).toHaveBeenCalledTimes(1);
    const [left, right] = compare.mock.calls[0] ?? [];
    expect((left as Buffer).length).toBe(16);
    expect((right as Buffer).length).toBe(16);
  });

  const check = (e: unknown, sig: unknown) => checkLink(linkKey, KEY, e, sig, NOW);

  it("signs to a fixed value, so links in flight keep opening across a deploy (the HKDF label is part of the contract)", () => {
    expect(signLink(linkKey, KEY, 1_800_000_300)).toBe("XFQdGlRjtX0LybxUzr6JxQ");
  });

  it("accepts only a signature and an expiry that are exactly the strings it signed, no padding, noise or spaces around them", () => {
    expect(check(String(expiry), s)).toBe(true);
    for (const noisy of [`${s}=`, `${s}!`, `!${s}`, `${s}\n`, ` ${s}`]) {
      expect(check(String(expiry), noisy), noisy).toBe(false);
    }
    for (const noisy of [`${expiry} `, ` ${expiry}`, `${expiry}.0`, `${expiry}\n`, `0${expiry}`]) {
      expect(check(noisy, s), noisy).toBe(false);
    }
  });

  it("refuses a value that is not a string even when it reads as the right string", () => {
    expect(checkLink(linkKey, KEY, String(expiry), reads(s), NOW)).toBe(false);
    expect(checkLink(linkKey, KEY, reads(String(expiry)), s, NOW)).toBe(false);
    expect(checkLink(linkKey, KEY, [String(expiry)], s, NOW)).toBe(false);
    expect(checkLink(linkKey, KEY, String(expiry), [s], NOW)).toBe(false);
  });
});
