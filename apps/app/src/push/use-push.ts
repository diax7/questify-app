import type { Language } from "@questify/shared";
import Constants from "expo-constants";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { channelNames } from "#src/push/channels.ts";
import { markNotificationsRead } from "#src/push/push-api.ts";
import { syncRegistration, type PushDeps, type SyncWho } from "#src/push/push-flow.ts";
import { pushEvents, pushNative } from "#src/push/push-native.ts";
import { openTap, responseKey, tapOf, type Tap } from "#src/push/tap.ts";
import { setUnread } from "#src/push/unread-store.ts";

/** The real phone, session and store for the push rules. */
export const pushDeps = (): PushDeps => ({
  native: pushNative,
  session: api.session,
  store: keyValueStore,
  now: Date.now,
});

/** Who the server is told this phone is: the app's language and the build's version. */
export const whoOf = (language: Language): SyncWho => ({
  language,
  appVersion: Constants.expoConfig?.version,
});

/**
 * While a player is signed in on a phone that can do push: the channels exist, the token is registered at launch, when
 * the phone announces a new one and when the app returns to the foreground (the rules in `syncRegistration` keep it to
 * a call a day otherwise), and a push that arrives with the app open shows as a banner and refreshes the bell.
 */
export function usePushRegistration(signedIn: boolean, reload: () => Promise<void>): void {
  const { language, t } = useI18n();
  useEffect(() => {
    if (!signedIn || !pushNative.available()) return;
    const who = whoOf(language);
    const names = channelNames(t);
    // Best effort: a failed try is made again at the next launch or foreground, so nothing waits on it.
    const run = (token?: string) =>
      void pushNative
        .ensureChannels(names)
        .catch(() => undefined)
        .then(() => syncRegistration(pushDeps(), who, token))
        .catch(() => undefined);
    pushEvents.showForegroundBanners();
    run();
    const stopToken = pushEvents.onToken((token) => run(token));
    const stopReceive = pushEvents.onReceive(() => void reload());
    const resume = AppState.addEventListener("change", (next) => {
      if (next === "active") run();
    });
    return () => {
      stopToken();
      stopReceive();
      resume.remove();
    };
  }, [signedIn, language, t, reload]);
}

/**
 * A resumed app reads the profile again, so the bell counts what reached the center while the app was away (a push
 * that came in the background, or a message with no push at all).
 */
export function useResumeRefresh(signedIn: boolean, reload: () => Promise<void>): void {
  useEffect(() => {
    if (!signedIn) return;
    const resume = AppState.addEventListener("change", (next) => {
      if (next === "active") void reload();
    });
    return () => resume.remove();
  }, [signedIn, reload]);
}

const tapIo = {
  open: (href: string) => router.push(href),
  openCenter: (row: number | null) =>
    router.push(row === null ? "/notifications" : `/notifications?row=${row}`),
  markRead: (id: number) =>
    void markNotificationsRead(api.session, { ids: [id] }).then((unread) => {
      if (unread !== null) setUnread(unread);
    }),
};

/**
 * Opens the screen a tapped push leads to, for a tap while the app runs and for the tap that started it. A tap that
 * arrives before the player is signed in waits for the sign-in; the same tap is never acted on twice.
 */
export function useNotificationTaps(signedIn: boolean): void {
  const signedInRef = useRef(signedIn);
  const waiting = useRef<Tap | null>(null);
  const handled = useRef(new Set<string>());

  useEffect(() => {
    signedInRef.current = signedIn;
    if (signedIn && waiting.current !== null) {
      const tap = waiting.current;
      waiting.current = null;
      openTap(tap, tapIo);
    }
  }, [signedIn]);

  useEffect(() => {
    if (!pushNative.available()) return;
    const handle = (response: unknown) => {
      const key = responseKey(response);
      if (key !== null) {
        if (handled.current.has(key)) return;
        handled.current.add(key);
      }
      const tap = tapOf(response);
      if (tap === null) return;
      if (signedInRef.current) openTap(tap, tapIo);
      else waiting.current = tap;
    };
    const last = pushEvents.lastResponse();
    if (last !== null && last !== undefined) {
      handle(last);
      pushEvents.clearLastResponse();
    }
    return pushEvents.onResponse(handle);
  }, []);
}
