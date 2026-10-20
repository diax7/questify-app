import { adventureTheme } from "#src/design/adventure";
import type { Theme } from "#src/design/theme";

/** Every theme the build ships. Adding one here puts it under the same contract tests (themes.test.ts). */
export const THEMES = { adventure: adventureTheme } as const satisfies Record<string, Theme>;

export type ThemeId = keyof typeof THEMES;

/** The theme the app and the web use until a choice of theme exists. */
export const DEFAULT_THEME: Theme = THEMES.adventure;
