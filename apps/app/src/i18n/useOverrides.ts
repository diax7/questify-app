import { NO_OVERRIDES, type Overrides } from "@questify/shared";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { api, keyValueStore } from "#src/api/app-session.ts";
import {
  TRANSLATIONS_REFRESH_MS,
  cachedTranslations,
  loadTranslations,
} from "#src/config/translations.ts";

const sameTexts = (a: Overrides, b: Overrides): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The texts a Questify admin changed in the console (T-702, FR-1766): the last working copy at once, then the server's,
 * and again every 30 seconds while the app is in the foreground and whenever it comes back to it, so an edit shows within
 * a minute without a release. A phone that cannot reach the server, or cannot use a value, keeps showing the shipped text.
 */
export function useOverrides(): Overrides {
  const [texts, setTexts] = useState<Overrides>(NO_OVERRIDES);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const show = (next: Overrides): void => {
      if (active) {
        setTexts((current) => (sameTexts(current, next) ? current : next));
      }
    };
    // A storage or network fault leaves the texts as they are: the shipped ones are always a safe answer.
    const refresh = (): void => {
      void loadTranslations({ client: api.client, store: keyValueStore }).then(
        show,
        () => undefined,
      );
    };
    const start = (): void => {
      refresh();
      timer ??= setInterval(refresh, TRANSLATIONS_REFRESH_MS);
    };
    const stop = (): void => {
      clearInterval(timer);
      timer = undefined;
    };
    void cachedTranslations(keyValueStore).then(show, () => undefined);
    if (AppState.currentState !== "background") {
      start();
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        start();
      } else {
        stop();
      }
    });
    return () => {
      active = false;
      stop();
      subscription.remove();
    };
  }, []);
  return texts;
}
