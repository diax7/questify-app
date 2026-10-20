import type { Theme } from "#src/design/theme";

/**
 * The brand deck's colours (ADR-013). `inkBrown` and `creamShade` are derived neutrals the deck has no name for;
 * `parchmentLight` and `emberMist` are lighter tints for raised surfaces and error panels.
 */
export const adventurePalette = {
  treasureGold: "#FFC94D",
  honeyGlow: "#FFA93C",
  adventureOrange: "#FF7A3D",
  woodBrown: "#8B5A2B",
  leafGreen: "#68C05B",
  treasureBlue: "#4AA5E6",
  mapCream: "#FFF5E1",
  inkBrown: "#3B2610",
  creamShade: "#E9D5B0",
  parchmentLight: "#FFFCF5",
  emberMist: "#FDE8E0",
} as const;

const p = adventurePalette;

/** The adventure theme: wood, parchment and gold (ADR-013), Baloo Bhaijaan 2 and Rubik (ADR-017). */
export const adventureTheme: Theme = {
  id: "adventure",
  colors: {
    background: p.mapCream,
    surface: p.parchmentLight,
    text: p.inkBrown,
    textMuted: p.woodBrown,
    border: p.creamShade,
    navigationBar: p.woodBrown,
    navigationActive: p.treasureGold,
    navigationInactive: p.creamShade,
    primaryAction: p.leafGreen,
    onPrimaryAction: p.inkBrown,
    secondaryAction: p.treasureBlue,
    highlight: p.honeyGlow,
    hot: p.adventureOrange,
    dangerSurface: p.emberMist,
    focus: p.treasureBlue,
  },
  fonts: { display: "Baloo Bhaijaan 2", body: "Rubik" },
  text: {
    display: { font: "display", weight: 800, size: 32, lineHeight: 44 },
    title: { font: "display", weight: 700, size: 22, lineHeight: 32 },
    body: { font: "body", weight: 400, size: 16, lineHeight: 24 },
    label: { font: "body", weight: 600, size: 13, lineHeight: 18 },
  },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 8, md: 12, lg: 20, pill: 999 },
};
