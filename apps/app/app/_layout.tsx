import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { DEFAULT_THEME } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { I18nProvider } from "#src/i18n/provider.tsx";
import { FONT_FILES } from "#src/theme/fonts.ts";
import { ThemeProvider } from "#src/theme/theme.tsx";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsReady, fontError] = useFonts(FONT_FILES);
  const [languageReady, setLanguageReady] = useState(false);
  const onLanguageReady = useCallback(() => setLanguageReady(true), []);

  // A font that fails to load must not keep the app on the splash screen: the system font is used instead.
  const ready = languageReady && (fontsReady || fontError !== null);
  useEffect(() => {
    if (ready) {
      void SplashScreen.hideAsync();
    }
  }, [ready]);

  return (
    <ThemeProvider theme={DEFAULT_THEME}>
      <I18nProvider onReady={onLanguageReady}>
        <StatusBar style="dark" />
        {ready ? <Stack screenOptions={{ headerShown: false }} /> : null}
      </I18nProvider>
    </ThemeProvider>
  );
}
