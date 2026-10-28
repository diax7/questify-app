import { useEffect } from "react";
import { usePlayer } from "#src/auth/player.tsx";
import { useNotificationTaps, usePushRegistration, useResumeRefresh } from "#src/push/use-push.ts";
import { setUnread } from "#src/push/unread-store.ts";

/**
 * The root layout's push host (T-501c): it keeps the bell's count from the profile, registers this phone for push while
 * a player is signed in and opens the screen a tapped push leads to. It shows nothing. Where the build has no push
 * modules, or the phone is a simulator, only the count works.
 */
export function PushHost() {
  const { state, reload } = usePlayer();
  const signedIn = state.status === "signed_in";
  // Each profile read makes a new object, so a count that came back to an earlier value still reaches the store.
  const notifications = state.status === "signed_in" ? state.me?.notifications : undefined;

  useEffect(() => {
    if (state.status === "signed_out") setUnread(0);
  }, [state.status]);
  useEffect(() => {
    if (notifications !== undefined) setUnread(notifications.unread);
  }, [notifications]);

  usePushRegistration(signedIn, reload);
  useResumeRefresh(signedIn, reload);
  useNotificationTaps(signedIn);
  return null;
}
