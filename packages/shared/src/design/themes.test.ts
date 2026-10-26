import { describe, expect, it } from "vitest";
import { adventurePalette, adventureTheme } from "#src/design/adventure";
import { DEFAULT_THEME, THEMES } from "#src/design/themes";

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

describe.each(Object.entries(THEMES))("the %s theme", (id, theme) => {
  it("is registered under its own id", () => {
    expect(theme.id).toBe(id);
  });

  it("writes every colour as six hex digits", () => {
    for (const [role, hex] of Object.entries(theme.colors)) {
      expect(hex, role).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("keeps text readable (WCAG AA, AAA for body text on the page)", () => {
    const c = theme.colors;
    expect(contrast(c.text, c.background)).toBeGreaterThanOrEqual(7);
    expect(contrast(c.text, c.surface)).toBeGreaterThanOrEqual(7);
    expect(contrast(c.text, c.dangerSurface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.textMuted, c.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.textMuted, c.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.onPrimaryAction, c.primaryAction)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.navigationInactive, c.navigationBar)).toBeGreaterThanOrEqual(3);
    expect(contrast(c.navigationActive, c.navigationBar)).toBeGreaterThanOrEqual(3);
  });

  it("makes the focus ring and borders of controls visible on the page (WCAG 1.4.11)", () => {
    expect(contrast(theme.colors.focus, theme.colors.background)).toBeGreaterThanOrEqual(2);
    expect(contrast(theme.colors.primaryAction, theme.colors.background)).toBeGreaterThanOrEqual(2);
  });

  it("shows each achievement ring against the page (3:1) and tells the three tiers apart", () => {
    const c = theme.colors;
    for (const ring of [c.tierBronze, c.tierSilver, c.tierGold]) {
      expect(contrast(ring, c.background)).toBeGreaterThanOrEqual(3);
      expect(contrast(ring, c.surface)).toBeGreaterThanOrEqual(3);
    }
    expect(new Set([c.tierBronze, c.tierSilver, c.tierGold]).size).toBe(3);
  });

  it("grows spacing and radius in order", () => {
    const steps = Object.values(theme.spacing);
    expect(steps).toEqual(steps.toSorted((a, b) => a - b));
    const radii = Object.values(theme.radius);
    expect(radii).toEqual(radii.toSorted((a, b) => a - b));
  });

  it("leaves room between lines for Arabic (line height at least 1.35 times the size)", () => {
    for (const [variant, style] of Object.entries(theme.text)) {
      expect(style.lineHeight / style.size, variant).toBeGreaterThanOrEqual(1.35);
    }
  });
});

describe("the adventure theme", () => {
  it("holds the brand deck's seven colours (ADR-013)", () => {
    expect(adventurePalette).toMatchObject({
      treasureGold: "#FFC94D",
      honeyGlow: "#FFA93C",
      adventureOrange: "#FF7A3D",
      woodBrown: "#8B5A2B",
      leafGreen: "#68C05B",
      treasureBlue: "#4AA5E6",
      mapCream: "#FFF5E1",
    });
  });

  it("only uses its own palette", () => {
    const known = new Set<string>(Object.values(adventurePalette));
    for (const [role, hex] of Object.entries(adventureTheme.colors)) {
      expect(known.has(hex), role).toBe(true);
    }
  });

  it("sets titles in Baloo Bhaijaan 2 and reading text in Rubik (ADR-017)", () => {
    expect(adventureTheme.fonts).toEqual({ display: "Baloo Bhaijaan 2", body: "Rubik" });
    expect(adventureTheme.text.display.font).toBe("display");
    expect(adventureTheme.text.title.font).toBe("display");
    expect(adventureTheme.text.body.font).toBe("body");
    expect(adventureTheme.text.label.font).toBe("body");
  });

  it("is the default", () => {
    expect(DEFAULT_THEME).toBe(adventureTheme);
  });
});
