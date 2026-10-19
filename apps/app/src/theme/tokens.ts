/**
 * Design tokens. Components use these names and never a raw colour, size or font (T-009), so a second theme can be
 * added later by changing this file (NFR-024). The seven palette colours come from the brand deck (ADR-013);
 * `inkBrown` and `creamShade` are derived neutrals the deck has no name for, to be confirmed with the design system.
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

/** Font family names as registered with expo-font (see fonts.ts). Display is Baloo Bhaijaan 2, body is Rubik (ADR-017). */
export const fontFamily = {
  displayMedium: "BalooBhaijaan2_500Medium",
  displaySemiBold: "BalooBhaijaan2_600SemiBold",
  displayBold: "BalooBhaijaan2_700Bold",
  displayExtraBold: "BalooBhaijaan2_800ExtraBold",
  body: "Rubik_400Regular",
  bodyMedium: "Rubik_500Medium",
  bodySemiBold: "Rubik_600SemiBold",
  bodyBold: "Rubik_700Bold",
} as const;

export type TextVariant = "display" | "title" | "body" | "label";

/** One place that says how each kind of text looks. */
export const typography: Readonly<
  Record<TextVariant, { fontFamily: string; fontSize: number; lineHeight: number }>
> = {
  display: { fontFamily: fontFamily.displayExtraBold, fontSize: 32, lineHeight: 44 },
  title: { fontFamily: fontFamily.displayBold, fontSize: 22, lineHeight: 32 },
  body: { fontFamily: fontFamily.body, fontSize: 16, lineHeight: 24 },
  label: { fontFamily: fontFamily.bodySemiBold, fontSize: 13, lineHeight: 18 },
};
