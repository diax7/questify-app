/**
 * The brand's design tokens shared by the app and the web (T-009, T-011). Screens use these names and never a raw
 * colour or size, so a second theme can be added later by changing this file (NFR-024). The seven palette colours
 * come from the brand deck (ADR-013); `inkBrown` and `creamShade` are derived neutrals the deck has no name for, to be
 * confirmed with the design system. Fonts and type sizes stay with each platform (their names differ).
 */
export const palette = {
  treasureGold: "#FFC94D",
  honeyGlow: "#FFA93C",
  adventureOrange: "#FF7A3D",
  woodBrown: "#8B5A2B",
  leafGreen: "#68C05B",
  treasureBlue: "#4AA5E6",
  mapCream: "#FFF5E1",
  inkBrown: "#3B2610",
  creamShade: "#E9D5B0",
} as const;

export const colors = {
  background: palette.mapCream,
  text: palette.inkBrown,
  textMuted: palette.woodBrown,
  navigationBar: palette.woodBrown,
  navigationActive: palette.treasureGold,
  navigationInactive: palette.creamShade,
  primaryAction: palette.leafGreen,
  secondaryAction: palette.treasureBlue,
  highlight: palette.honeyGlow,
  hot: palette.adventureOrange,
  border: palette.creamShade,
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 8, md: 12, lg: 20, pill: 999 } as const;
