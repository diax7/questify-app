import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { DEFAULT_THEME } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { router, useSegments } from "expo-router";
import { setApiLanguage } from "#src/api/app-session.ts";
import { PlayerProvider, usePlayer } from "#src/auth/player.tsx";
import { atLanding, consentStepDue } from "#src/marketing/marketing-flow.ts";
import { I18nProvider, useI18n } from "#src/i18n/provider.tsx";
import { QuestifySyncProvider } from "#src/questify/QuestifySyncProvider.tsx";
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
        <PlayerProvider>
          <ApiLanguage />
          <QuestifySyncProvider>
            {ready ? <ReacceptGate /> : null}
            {ready ? <ConsentGate /> : null}
            {ready ? <Stack screenOptions={{ headerShown: false }} /> : null}
          </QuestifySyncProvider>
        </PlayerProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

/** The API answers in the app's language. */
function ApiLanguage() {
  const { language } = useI18n();
  useEffect(() => setApiLanguage(language), [language]);
  return null;
}

/**
 * The one-time marketing step (FR-735, T-407b): offered when the player lands on Questify home or the launch screen,
 * never over a join, a sign-in or a game in progress, and never before a new terms or privacy version is accepted.
 */
function ConsentGate() {
  const { state } = usePlayer();
  const segments = useSegments();
  const due =
    state.status === "signed_in" &&
    (state.me?.legal.toAccept.length ?? 0) === 0 &&
    consentStepDue(state.me?.marketing);
  useEffect(() => {
    if (due && atLanding(segments)) {
      router.replace("/marketing-consent");
    }
  }, [due, segments]);
  return null;
}

/** A new terms or privacy version comes before anything else (FR-1705). */
function ReacceptGate() {
  const { state } = usePlayer();
  const segments = useSegments();
  const due = state.status === "signed_in" && (state.me?.legal.toAccept.length ?? 0) > 0;
  useEffect(() => {
    if (due && segments[0] !== "reaccept") {
      router.replace("/reaccept");
    }
  }, [due, segments]);
  return null;
}
