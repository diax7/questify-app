/**
 * What a visual theme must provide (NFR-024). Screens and components on every platform read these roles and never a
 * raw colour, size or font file, so a completely different theme is a new `Theme` value plus its font files, with no
 * screen rewritten. A theme is code, not data (ADR-093); organizers never pick one.
 */
export type ColorRole =
  | "background"
  | "surface"
  | "text"
  | "textMuted"
  | "border"
  | "navigationBar"
  | "navigationActive"
  | "navigationInactive"
  | "primaryAction"
  | "onPrimaryAction"
  | "secondaryAction"
  | "highlight"
  | "hot"
  | "dangerSurface"
  | "focus";

export type TextVariant = "display" | "title" | "body" | "label";

/** A font by its role; each platform maps (role, weight) to the font files it ships. */
export type FontRole = "display" | "body";
export type FontWeight = 400 | 500 | 600 | 700 | 800;

export type TextStyle = Readonly<{
  font: FontRole;
  weight: FontWeight;
  size: number;
  lineHeight: number;
}>;

export type SpacingStep = "xs" | "sm" | "md" | "lg" | "xl" | "xxl";
export type RadiusStep = "sm" | "md" | "lg" | "pill";

export type Theme = Readonly<{
  id: string;
  colors: Readonly<Record<ColorRole, string>>;
  /** The family name of each font role, as each platform's font registry knows it. */
  fonts: Readonly<Record<FontRole, string>>;
  text: Readonly<Record<TextVariant, TextStyle>>;
  spacing: Readonly<Record<SpacingStep, number>>;
  radius: Readonly<Record<RadiusStep, number>>;
}>;
