import { describe, expect, it } from "vitest";
import { clientOf } from "#src/devices/client";
import {
  PAIRING_ALPHABET,
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
} from "#src/devices/pairing-code";

describe("pairing codes (T-309)", () => {
  it("uses 31 characters without 0, O, 1, I and L", () => {
    expect(PAIRING_ALPHABET).toHaveLength(31);
    for (const excluded of ["0", "O", "1", "I", "L"]) {
      expect(PAIRING_ALPHABET).not.toContain(excluded);
    }
    expect(new Set(PAIRING_ALPHABET).size).toBe(31);
  });

  it("draws 8 characters of the alphabet, and uses all of it", () => {
    const seen = new Set<string>();
    for (let round = 0; round < 400; round += 1) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/);
      for (const character of code) {
        seen.add(character);
      }
    }
    expect(seen.size).toBe(31);
  });

  it("shows a code as two groups of four", () => {
    expect(formatPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });

  it("ignores case, dashes and spaces; refuses the excluded letters and any other length", () => {
    expect(normalizePairingCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizePairingCode(" AB CD - EF GH ")).toBe("ABCDEFGH");
    expect(normalizePairingCode("ABCDEFG")).toBeUndefined();
    expect(normalizePairingCode("ABCDEFGHJ")).toBeUndefined();
    expect(normalizePairingCode("ABCDEFG0")).toBeUndefined();
    expect(normalizePairingCode("ABCDEFGO")).toBeUndefined();
    expect(normalizePairingCode("ABCDEFGI")).toBeUndefined();
    expect(normalizePairingCode("ABCDEFG1")).toBeUndefined();
    expect(normalizePairingCode("ABCDEFGL")).toBeUndefined();
    expect(normalizePairingCode("ABCD_EFG")).toBeUndefined();
    expect(normalizePairingCode("")).toBeUndefined();
  });
});

describe("the client line (T-309)", () => {
  it("names a browser and a system, never a version or a model", () => {
    expect(
      clientOf(
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome on Android");
    expect(
      clientOf(
        "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPadOS");
    expect(
      clientOf(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      ),
    ).toBe("Edge on Windows");
    expect(
      clientOf(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0",
      ),
    ).toBe("Firefox on macOS");
    expect(
      clientOf(
        "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/6.0 TV Safari/537.36",
      ),
    ).toBe("Samsung Internet on a TV");
    expect(
      clientOf(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Chrome on iOS");
  });

  it("answers what it knows, or nothing", () => {
    expect(clientOf(undefined)).toBe("");
    expect(clientOf("curl/8.4.0")).toBe("");
    expect(clientOf("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux");
    expect(clientOf("x".repeat(500))).toBe("");
  });
});
