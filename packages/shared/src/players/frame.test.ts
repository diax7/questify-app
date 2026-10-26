import { describe, expect, it } from "vitest";
import { adventurePalette } from "#src/design/adventure";
import { frameDesign } from "#src/players/frame";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

const key = (index: number) => `frame-${String(index).padStart(2, "0")}`;
const levelFrames = Array.from({ length: 14 }, (_, i) => frameDesign(key(i + 1)));
const shopFrames = Array.from({ length: 6 }, (_, i) => frameDesign(key(i + 15)));

describe("frameDesign", () => {
  it("knows the fourteen level frames and the six gem shop rings, and nothing else", () => {
    expect([...levelFrames, ...shopFrames].every((frame) => frame !== null)).toBe(true);
    for (const unknown of [null, undefined, "", "frame-00", "frame-21", "frame-1", "toString"]) {
      expect(frameDesign(unknown)).toBeNull();
    }
  });

  it("gives every ring a look of its own", () => {
    const looks = [...levelFrames, ...shopFrames].map((frame) => JSON.stringify(frame));
    expect(new Set(looks).size).toBe(20);
  });

  it("keeps the shop rings out of the level frames' colours, so a bought ring is not mistaken for a reward", () => {
    const levelColors = new Set(levelFrames.map((frame) => frame?.color));
    for (const frame of shopFrames) expect(levelColors.has(frame?.color)).toBe(false);
  });

  it("draws every shop ring at 3:1 or more on the page", () => {
    for (const frame of shopFrames) {
      expect(contrast(frame?.color ?? "#FFFFFF", adventurePalette.mapCream)).toBeGreaterThanOrEqual(
        3,
      );
    }
  });
});
