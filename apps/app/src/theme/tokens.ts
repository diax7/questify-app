/**
 * Design tokens for the app. The palette, colours, spacing and radius are shared with the web
 * (`packages/shared/src/design/tokens.ts`); the font names and type scale here are the app's own (expo-font).
 */
export { colors, palette, radius, spacing } from "@questify/shared";

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
