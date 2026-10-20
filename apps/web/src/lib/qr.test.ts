import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { QUIET_ZONE, qrDrawing, qrSvgFile } from "#src/lib/qr.ts";

const URL = `https://questify.nafes.com/q/${"A".repeat(50)}`;

describe("qrDrawing", () => {
  it("draws every dark module of the code, and nothing in the quiet zone", () => {
    const { size, path } = qrDrawing(URL);
    const { data } = encode(URL, { ecc: "M", border: QUIET_ZONE });
    const dark = data.flat().filter(Boolean).length;
    expect(path.match(/M/g)).toHaveLength(dark);
    for (const [, x, y] of path.matchAll(/M(\d+) (\d+)/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(Number(y)).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(Number(x)).toBeLessThan(size - QUIET_ZONE);
      expect(Number(y)).toBeLessThan(size - QUIET_ZONE);
    }
  });

  it("uses a small code for a quest URL (version 5 or below, so it prints small and scans fast)", () => {
    const { size } = qrDrawing(URL);
    expect(size - 2 * QUIET_ZONE).toBeLessThanOrEqual(37);
  });

  it("is the same drawing every time for the same text, and another for other text", () => {
    expect(qrDrawing(URL)).toEqual(qrDrawing(URL));
    expect(qrDrawing(URL).path).not.toBe(qrDrawing(`${URL}B`).path);
  });
});

describe("qrSvgFile", () => {
  it("is black on white with no transform, so nothing mirrors it right to left", () => {
    const file = qrSvgFile(URL);
    expect(file.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(file).toContain('fill="#ffffff"');
    expect(file).toContain('fill="#000000"');
    expect(file).not.toContain("transform");
    expect(file).toContain(qrDrawing(URL).path);
  });
});
