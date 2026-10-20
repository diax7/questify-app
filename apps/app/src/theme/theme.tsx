import { DEFAULT_THEME, type TextVariant, type Theme } from "@questify/shared";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import { fontFor } from "#src/theme/font-faces.ts";

type NativeTextStyle = Readonly<{ fontFamily: string; fontSize: number; lineHeight: number }>;

/** How each text variant of a theme looks on the phone: the theme's sizes with the app's registered font names. */
export function nativeTextStyles(theme: Theme): Readonly<Record<TextVariant, NativeTextStyle>> {
  const entries = Object.entries(theme.text).map(([variant, style]) => [
    variant,
    {
      fontFamily: fontFor(theme.fonts[style.font], style.weight),
      fontSize: style.size,
      lineHeight: style.lineHeight,
    },
  ]);
  return Object.fromEntries(entries) as Record<TextVariant, NativeTextStyle>;
}

type ThemeValue = Readonly<{ theme: Theme; text: Readonly<Record<TextVariant, NativeTextStyle>> }>;

const ThemeContext = createContext<ThemeValue>({
  theme: DEFAULT_THEME,
  text: nativeTextStyles(DEFAULT_THEME),
});

/** Gives every screen below it one theme; a different theme here restyles the whole app. */
export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  const value = useMemo(() => ({ theme, text: nativeTextStyles(theme) }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

/**
 * Builds a component's styles from the current theme, once per theme. Components write
 * `const styles = useThemedStyles(makeStyles)` with `makeStyles` defined outside the component.
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(make: (theme: Theme) => T): T {
  const { theme } = useTheme();
  return useMemo(() => StyleSheet.create(make(theme)), [make, theme]);
}
