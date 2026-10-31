import { describe, expect, it } from "vitest";
import {
  ACCENTS,
  ACCENT_KEYS,
  DEFAULT_BRANDING,
  isAccentKey,
  readBranding,
  themeWithAccent,
} from "#src/design/accents";
import { adventurePalette, adventureTheme } from "#src/design/adventure";
import { MESSAGES } from "#src/i18n/messages";

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe.each(ACCENT_KEYS)("the %s accent", (key) => {
  const { hex, label } = ACCENTS[key];

  it("keeps the button's ink readable on it (WCAG AA, 4.5:1)", () => {
    expect(contrast(adventurePalette.inkBrown, hex)).toBeGreaterThanOrEqual(4.5);
  });

  it("stands out from the page and the raised surface (2:1, as the theme's own action colour does)", () => {
    expect(contrast(hex, adventurePalette.mapCream)).toBeGreaterThanOrEqual(2);
    expect(contrast(hex, adventurePalette.parchmentLight)).toBeGreaterThanOrEqual(2);
  });

  it("is six hex digits with a name in both languages", () => {
    expect(hex).toMatch(/^#[0-9A-F]{6}$/);
    expect(MESSAGES[label].ar).not.toBe("");
    expect(MESSAGES[label].en).not.toBe("");
  });
});

describe("the accent list", () => {
  it("has no repeated colour and none the theme already uses for actions", () => {
    const hexes = ACCENT_KEYS.map((key) => ACCENTS[key].hex);
    expect(new Set(hexes).size).toBe(hexes.length);
    expect(hexes).not.toContain(adventureTheme.colors.primaryAction);
  });

  it("knows its keys and nothing inherited", () => {
    expect(isAccentKey("sky")).toBe(true);
    expect(isAccentKey("toString")).toBe(false);
    expect(isAccentKey("#4AA5E6")).toBe(false);
    expect(isAccentKey(null)).toBe(false);
  });
});

describe("readBranding", () => {
  it("reads a stored accent and treats anything else as none", () => {
    expect(readBranding({ accent: "honey" })).toEqual({ accent: "honey" });
    expect(readBranding({ accent: "neon" })).toBe(DEFAULT_BRANDING);
    expect(readBranding({})).toBe(DEFAULT_BRANDING);
    expect(readBranding(undefined)).toBe(DEFAULT_BRANDING);
    expect(readBranding(["sky"])).toBe(DEFAULT_BRANDING);
    expect(readBranding("sky")).toBe(DEFAULT_BRANDING);
  });
});

describe("themeWithAccent", () => {
  it("gives the theme back untouched when there is no accent", () => {
    expect(themeWithAccent(adventureTheme, null)).toBe(adventureTheme);
  });

  it.each(ACCENT_KEYS)(
    "changes only the primary action's two colours for %s (ADR-013 frame)",
    (key) => {
      const themed = themeWithAccent(adventureTheme, key);
      expect(themed.colors.primaryAction).toBe(ACCENTS[key].hex);
      const { primaryAction: _a, onPrimaryAction: _b, ...kept } = themed.colors;
      const { primaryAction: _c, onPrimaryAction: _d, ...before } = adventureTheme.colors;
      expect(kept).toEqual(before);
      expect(themed.fonts).toBe(adventureTheme.fonts);
      expect(themed.text).toBe(adventureTheme.text);
      expect(
        contrast(themed.colors.onPrimaryAction, themed.colors.primaryAction),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});
