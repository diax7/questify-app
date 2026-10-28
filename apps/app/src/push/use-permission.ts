import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useI18n } from "#src/i18n/provider.tsx";
import { channelNames } from "#src/push/channels.ts";
import { turnOn, type PermissionState } from "#src/push/push-flow.ts";
import { pushNative } from "#src/push/push-native.ts";
import { pushDeps, whoOf } from "#src/push/use-push.ts";

/** What Settings knows of push on this phone: not read yet, impossible here, or the system's answer. */
export type PhonePush = "loading" | "unavailable" | PermissionState;

/**
 * The phone's push permission for Settings (FR-1105): read when the screen gains focus and when the app returns to the
 * foreground, so coming back from the phone's own settings shows the new state. `ask` shows the system prompt (the
 * player pressed Turn on here, so no explainer comes first).
 */
export function usePhonePush(): Readonly<{ state: PhonePush; ask: () => void }> {
  const { language, t } = useI18n();
  const [state, setState] = useState<PhonePush>("loading");

  const read = useCallback(async () => {
    if (!pushNative.available()) {
      setState("unavailable");
      return;
    }
    setState(await pushNative.permission().catch(() => "denied" as const));
  }, []);

  useFocusEffect(
    useCallback(() => {
      void read();
    }, [read]),
  );
  useEffect(() => {
    const resume = AppState.addEventListener("change", (next) => {
      if (next === "active") void read();
    });
    return () => resume.remove();
  }, [read]);

  const ask = () => {
    void turnOn(pushDeps(), whoOf(language), channelNames(t)).then(read);
  };
  return { state, ask };
}
