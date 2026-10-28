import type { Language } from "@questify/shared";
import Constants from "expo-constants";
import { router, usePathname } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { channelNames } from "#src/push/channels.ts";
import { markNotificationsRead, refreshUnread } from "#src/push/push-api.ts";
import { syncRegistration, type PushDeps, type SyncWho } from "#src/push/push-flow.ts";
import { pushEvents, pushNative } from "#src/push/push-native.ts";
import { openTap, responseKey, settleTap, tapOf, type Tap, type TapPlace } from "#src/push/tap.ts";
import { setUnreadIfRead } from "#src/push/unread-store.ts";

/** The real phone, session and store for the push rules. */
export const pushDeps = (): PushDeps => ({
  native: pushNative,
  session: api.session,
  store: keyValueStore,
  now: Date.now,
});

/** Who the server is told this phone is: the player, the app's language and the build's version. */
export const whoOf = (language: Language, playerId: string | undefined): SyncWho => ({
  playerId,
  language,
  appVersion: Constants.expoConfig?.version,
});

/**
 * While a player is signed in on a phone that can do push: the channels exist, the token is registered at launch, when
 * the phone announces a new one and when the app returns to the foreground (the rules in `syncRegistration` keep it to
 * a call a day otherwise), and a push that arrives with the app open shows as a banner and refreshes the bell.
 */
export function usePushRegistration(playerId: string | undefined): void {
  const { language, t } = useI18n();
  useEffect(() => {
    if (playerId === undefined || !pushNative.available()) return;
    const who = whoOf(language, playerId);
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
    const stopReceive = pushEvents.onReceive(() => void refreshUnread(api.session));
    const resume = AppState.addEventListener("change", (next) => {
      if (next === "active") run();
    });
    return () => {
      stopToken();
      stopReceive();
      resume.remove();
    };
  }, [playerId, language, t]);
}

/**
 * A resumed app reads the unread count again, so the bell counts what reached the center while the app was away (a
 * push that came in the background, or a message with no push at all). Only the count: never the profile, whose failed
 * read would blank `me` under a game in progress.
 */
export function useResumeRefresh(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn) return;
    const resume = AppState.addEventListener("change", (next) => {
      if (next === "active") void refreshUnread(api.session);
    });
    return () => resume.remove();
  }, [signedIn]);
}

const tapIo = {
  open: (href: string) => router.push(href),
  openCenter: (row: number | null) =>
    router.push(row === null ? "/notifications" : `/notifications?row=${row}`),
  markRead: (id: number) =>
    void markNotificationsRead(api.session, { ids: [id] }).then(setUnreadIfRead),
};

/**
 * Opens the screen a tapped push leads to, for a tap while the app runs and for the tap that started it. A tap waits
 * for the sign-in and for the launch screen to leave (`settleTap`), is dropped on sign-out, and is never acted on twice.
 */
export function useNotificationTaps(status: TapPlace["status"]): void {
  const pathname = usePathname();
  const place = useRef<TapPlace>({ status, pathname });
  place.current = { status, pathname };
  const waiting = useRef<Tap | null>(null);
  const handled = useRef(new Set<string>());

  const settle = useCallback((arrived: Tap | null) => {
    const next = settleTap(waiting.current, place.current, arrived);
    waiting.current = next.waiting;
    if (next.open !== null) openTap(next.open, tapIo);
  }, []);

  useEffect(() => settle(null), [status, pathname, settle]);

  useEffect(() => {
    if (!pushNative.available()) return;
    const handle = (response: unknown) => {
      const key = responseKey(response);
      if (key !== null) {
        if (handled.current.has(key)) return;
        handled.current.add(key);
      }
      settle(tapOf(response));
    };
    const last = pushEvents.lastResponse();
    if (last !== null && last !== undefined) {
      handle(last);
      pushEvents.clearLastResponse();
    }
    return pushEvents.onResponse(handle);
  }, [settle]);
}
