import { adventurePalette } from "#src/design/adventure";
import type { Theme } from "#src/design/theme";
import type { MessageKey } from "#src/i18n/messages";

/**
 * The accent colours an organizer may pick for an event (FR-1023, ADR-085). A curated list, never a free colour: every
 * entry keeps the adventure theme's dark ink readable on it (WCAG AA, 4.5:1) and stands out from the parchment page, which
 * `accents.test.ts` proves for each. Questify green, the theme's own `primaryAction`, is what an event with no pick shows.
 */
export const ACCENTS = {
  sky: { hex: "#4AA5E6", label: "branding.accent.sky" },
  ember: { hex: "#FF7A3D", label: "branding.accent.ember" },
  rose: { hex: "#F27D9B", label: "branding.accent.rose" },
  violet: { hex: "#A98BE8", label: "branding.accent.violet" },
  lagoon: { hex: "#3FBFAE", label: "branding.accent.lagoon" },
  honey: { hex: "#E0A526", label: "branding.accent.honey" },
} as const satisfies Record<string, Readonly<{ hex: string; label: MessageKey }>>;

export type AccentKey = keyof typeof ACCENTS;

/** The keys in the order the picker lists them. */
export const ACCENT_KEYS = Object.keys(ACCENTS) as readonly AccentKey[];

export function isAccentKey(value: unknown): value is AccentKey {
  return typeof value === "string" && Object.hasOwn(ACCENTS, value);
}

/** What an event stores and the app reads of its look; `accent` null means Questify's own colour. */
export type Branding = Readonly<{ accent: AccentKey | null }>;

export const DEFAULT_BRANDING: Branding = { accent: null };

/** Reads the branding block of an event's stored config; anything that is not a known accent counts as none. */
export function readBranding(stored: unknown): Branding {
  const accent =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)["accent"]
      : undefined;
  return isAccentKey(accent) ? { accent } : DEFAULT_BRANDING;
}

/**
 * The theme an event's screens use: the base theme with the accent as the fill of primary actions, and the base theme's own
 * ink on it. The wood bar, parchment surfaces, fonts and every other role stay the brand's (ADR-013).
 */
export function themeWithAccent(base: Theme, accent: AccentKey | null): Theme {
  if (accent === null) {
    return base;
  }
  return {
    ...base,
    colors: {
      ...base.colors,
      primaryAction: ACCENTS[accent].hex,
      onPrimaryAction: adventurePalette.inkBrown,
    },
  };
}
