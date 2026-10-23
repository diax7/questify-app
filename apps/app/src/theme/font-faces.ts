import type { FontWeight } from "@questify/shared";

/**
 * Which registered font serves a theme's font family at each weight. A theme with other fonts adds its family here
 * and its files in fonts.ts (typecheck fails until both match); screens never name a font (NFR-024). Both current
 * families cover Arabic and Latin (ADR-017).
 */
export const FONT_FACES = {
  "Baloo Bhaijaan 2": {
    500: "BalooBhaijaan2_500Medium",
    600: "BalooBhaijaan2_600SemiBold",
    700: "BalooBhaijaan2_700Bold",
    800: "BalooBhaijaan2_800ExtraBold",
  },
  Rubik: {
    400: "Rubik_400Regular",
    500: "Rubik_500Medium",
    600: "Rubik_600SemiBold",
    700: "Rubik_700Bold",
  },
} as const satisfies Record<string, Partial<Record<FontWeight, string>>>;

type Faces = typeof FONT_FACES;
export type FontName = { [F in keyof Faces]: Faces[F][keyof Faces[F]] }[keyof Faces];

/**
 * The registered font for a family at a weight, or the family's closest weight (the heavier one on a tie).
 *
 * @throws Error naming the family when it has no fonts registered, so a new theme fails in tests, not on a phone.
 */
export function fontFor(family: string, weight: FontWeight): FontName {
  const faces: Partial<Record<FontWeight, FontName>> | undefined = (
    FONT_FACES as Record<string, Partial<Record<FontWeight, FontName>>>
  )[family];
  const weights = Object.keys(faces ?? {}).map(Number) as FontWeight[];
  const closest = [...weights].sort(
    (a, b) => Math.abs(a - weight) - Math.abs(b - weight) || b - a,
  )[0];
  const name = closest === undefined ? undefined : faces?.[closest];
  if (name === undefined) {
    throw new Error(`No font files are registered for "${family}": add them to FONT_FACES.`);
  }
  return name;
}
