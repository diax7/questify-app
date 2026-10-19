import { describe, expect, it } from "vitest";
import { colors, fontFamily, palette, radius, spacing, typography } from "#src/theme/tokens.ts";

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe("palette", () => {
  it("holds the brand deck's seven colours (ADR-013)", () => {
    expect(palette).toMatchObject({
      treasureGold: "#FFC94D",
      honeyGlow: "#FFA93C",
      adventureOrange: "#FF7A3D",
      woodBrown: "#8B5A2B",
      leafGreen: "#68C05B",
      treasureBlue: "#4AA5E6",
      mapCream: "#FFF5E1",
    });
  });

  it("writes every colour as six hex digits", () => {
    for (const hex of Object.values(palette)) {
      expect(hex).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});

describe("colour roles", () => {
  it("only point at palette colours", () => {
    const known = new Set<string>(Object.values(palette));
    for (const [role, hex] of Object.entries(colors)) {
      expect(known.has(hex), role).toBe(true);
    }
  });

  it("keep text readable on the page and on the navigation bar", () => {
    expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(7);
    expect(contrast(colors.textMuted, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.navigationInactive, colors.navigationBar)).toBeGreaterThanOrEqual(3);
    expect(contrast(colors.navigationActive, colors.navigationBar)).toBeGreaterThanOrEqual(3);
  });
});

describe("spacing and radius", () => {
  it("grow in order", () => {
    const steps = Object.values(spacing);
    expect(steps).toEqual(steps.toSorted((a, b) => a - b));
    const radii = Object.values(radius);
    expect(radii).toEqual(radii.toSorted((a, b) => a - b));
  });
});

describe("typography", () => {
  it("sets titles in Baloo Bhaijaan 2 and reading text in Rubik (ADR-017)", () => {
    expect(typography.display.fontFamily).toMatch(/^BalooBhaijaan2_/);
    expect(typography.title.fontFamily).toMatch(/^BalooBhaijaan2_/);
    expect(typography.body.fontFamily).toMatch(/^Rubik_/);
    expect(typography.label.fontFamily).toMatch(/^Rubik_/);
  });

  it("uses only font names that are registered", () => {
    const registered = new Set<string>(Object.values(fontFamily));
    for (const variant of Object.values(typography)) {
      expect(registered.has(variant.fontFamily)).toBe(true);
    }
  });

  it("leaves room between lines for Arabic (line height at least 1.35 times the size)", () => {
    for (const variant of Object.values(typography)) {
      expect(variant.lineHeight / variant.fontSize).toBeGreaterThanOrEqual(1.35);
    }
  });
});
